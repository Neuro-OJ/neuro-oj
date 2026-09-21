# Agent Note: sitemap 缓存按 Host 无界增长（DoS）

Status: implemented

## Problem

`noj-ui/server/routes/sitemap.xml.ts` 的进程级缓存以 **origin** 为键：

```ts
const cache = new Map<string, { at: number; body: string }>();
...
cache.set(origin, { at: now, body });
```

当 `NUXT_SITE_URL` 未配置时，`resolveOrigin`（`server/utils/sitemap-origin.ts`）
回退到请求的 `Host` 头——而 Host 完全由客户端控制，`sanitizeHost` 只做形状校验
（任何合法主机名都接受）。

触发条件：对 `/sitemap.xml` 循环发送不同 Host：

```
GET /sitemap.xml   Host: a1.evil.com
GET /sitemap.xml   Host: a2.evil.com
...
```

实际行为：

1. 每个新 Host 是一个新键，**永不从 Map 删除**（过期条目只在被再次访问时
   才发现过期，且 `degraded` 分支仍可能返回旧缓存），内存随请求数线性增长；
2. 每个未命中键都会执行 `fetchAll` × 3 端点、每端点最多 `MAX_PAGES=10` ×
   `PER_PAGE=100` 的上游请求，形成对 noj-core 的放大。

即单个匿名客户端可用少量请求造成 UI 进程 OOM 与上游打满。文件头注释记录了
2026-09-12 的"缓存投毒"修复（按 origin 分键），但**只解决了串键污染，未解决
无界增长**：攻击者可控的键集合 + 无淘汰 = 资源耗尽面。

## Decision

抽出 `noj-ui/server/utils/sitemap-cache.ts` 的 `SitemapCache`（TTL + LRU）：

- 容量上限 `MAX_CACHE_ENTRIES = 100`，超出时淘汰最久未使用项
  （Map 的插入序即访问序，命中时删除重插以刷新 LRU）；
- `get(key, now)` 顺带清理过期条目；`set` 维持容量上限；
- 路由改用 `new SitemapCache({ ttlMs: CACHE_TTL_MS })`。

抽成独立模块的原因：路由文件末尾调用 `defineEventHandler`（Nitro 自动导入），
无法在单测中直接 import；此前只有"源码正则断言"。现在容量/淘汰策略可被真实断言。

回归用例（`noj-ui/tests/sitemapCache_test.ts`，6 条）：容量上限生效、LRU 淘汰
最久未用项、TTL 过期清除、默认上限有限、重复写同键不增长、路由不再使用裸 Map。

## Alternatives considered

1. **生产强制配置 `NUXT_SITE_URL` 后忽略 Host**：只解决"多键"不解决"单进程缓存
   仍需有界"，且未配置 `NUXT_SITE_URL` 是受支持的开发路径，不能依赖运维纪律。
2. **只在未配置 `NUXT_SITE_URL` 时禁用 Host 缓存**：可行但语义割裂——缓存容量
   上限对任何缓存都是基本要求，一处实现即可同时覆盖两种情况。
3. **改用外部缓存（Redis）**：拒绝（本轮）。sitemap 是低价值只读端点，引入
   外部依赖不划算；进程内有界 LRU 已足够。

## Consequences

- 缓存条目数被硬性限制在 100；伪造 Host 的 DoS 面消除（内存与上游扇出都有界）。
- 配置 `NUXT_SITE_URL` 时全部请求共用同一键，容量上限不影响既有行为。
- 未改动响应内容、状态码或 `cache-control` 语义。
