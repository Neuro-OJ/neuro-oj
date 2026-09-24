# Agent Note: 搜索限流的登录用户维度不可达（校园机房 NAT 下搜索不可用）

Status: implemented

## Problem

`noj-core/src/domains/search/middleware/search-rate-limit.ts` 实现了
`"anon" | "authed"` 两个维度，但 `GET /api/v1/search` 路由**永远**传 `"anon"`：

```ts
router.get("/", optionalAuthMiddleware, searchRateLimit("anon"), async (c) => { ... });
```

全仓 `rg 'searchRateLimit\('` 只有这一处调用。后果：

- 已登录用户也按**来源 IP** 计数（`ratelimit:search:ip:<ip>`），
  `rate_limit_search_max_authed` 是**死配置**；
- `noj-core/CLAUDE.md` 与设置注册表承诺的「登录用户 30s/120 次、
  `ratelimit:search:user:<user_id>`」从未生效；
- **校园机房 / 企业 NAT 场景**：整栋楼共享同一出口 IP，匿名用户把
  `rate_limit_search_max_anon`（默认 30s/60 次）打满后，**已登录用户也被
  429**——表现为"搜索功能突然不可用"，且用户无法通过登录改善。

实测（修复前，真实路由 + Redis）：

```
search route: 登录用户走用户维度桶，不受共享 IP 匿名配额影响 ... FAILED
error: AssertionError: 登录用户不得被共享 IP 的匿名配额挤占（NAT 场景）
```

## Decision

1. 中间件新增维度 `"auto"`：**按请求是否携带有效登录态自动选择**
   （`optionalAuthMiddleware` 已注入 `c.var.userId`）；
2. 路由改用 `searchRateLimit("auto")`；
3. 语义明确：**登录用户只走用户桶，不再叠加 IP 桶**——否则 NAT 问题依旧；
   匿名请求仍按 IP 计数，未削弱对匿名滥用的防护；
4. 显式 `"authed"` / `"anon"` 维度保留（供测试与未来单维度端点使用）。

回归用例（`noj-core/src/domains/search/tests/routes/search.test.ts`）新增 2 条：

- **NAT 场景**：匿名请求把共享 IP 的匿名配额（1）打满 → 匿名第 2 次 429；
  同一 IP 下的登录用户仍 200（走用户桶），且确认写入了用户维度计数键；
- 登录用户仍受**用户维度**上限约束（超出即 429）。

## Alternatives considered

1. **登录用户同时叠加 IP 桶与用户桶**：拒绝。这正是 NAT 场景下要消除的行为——
   共享 IP 的用户会互相挤占，登录态形同虚设。
2. **保留 `"anon"` 但把 `rate_limit_search_max_anon` 调大**：拒绝。治标不治本，
   且会削弱对匿名滥用的防护（校园网出口 IP 被单个爬虫刷爆时影响面更大）。
3. **在路由 handler 内自行判断并计数**：拒绝。限流逻辑应留在中间件（与登录
   限流的既有分层一致），否则维度选择逻辑会散落到路由。
4. **移除 `"authed"` 维度只留 `"auto"`**：拒绝。显式维度对测试与单维度端点
   仍有价值，且删除会扩大改动面。

## Consequences

- 已登录用户的搜索不再受共享出口 IP 的匿名配额影响；`rate_limit_search_max_authed`
  与文档描述恢复一致。
- 匿名请求行为完全不变（仍按 IP、仍用 `max_anon`）。
- 新增 `"auto"` 为路由的默认推荐维度；`SearchRateLimitDimension` 类型随之扩展。
