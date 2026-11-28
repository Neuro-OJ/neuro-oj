# 视图 BFF 与 SSR

Nitro 在 Nuxt 工程内聚合既有 Core API。Core 继续负责身份、业务授权和数据读取，
BFF 不访问 Core 数据库，不增加 Core API，不允许客户端任意指定上游路径。

## 视图接口

| 页面                 | GET 接口                                                          |
| -------------------- | ----------------------------------------------------------------- |
| 空间首页 `/d/:slug`  | `/api/bff/v1/domains/:slug/home`                                  |
| 题单详情（每页20题） | `/api/bff/v1/domains/:slug/trainings/:trainingId/overview?page=1` |

信封包含 `kind`、经 Core 验证的 `viewer`、`workspace` 和 `sections`。模块结构为
`{ data: <原接口响应> }` 或
`{ error: { statusCode, data: { error, code?, request_id? } } }`。
模块名与类型见 `utils/server/bff-view.ts`。

全局导航不再预取视图，也不向共享异步键写入私有快照。每个页面自己调用 BFF 并拥有
`useAsyncData` 的 key、AbortSignal 和首屏 DTO。这样 SSR
结果由同一个页面数据键进入 Nuxt
payload，水合不会把旧页面的响应注入新页面；刷新、分页、筛选和 SSE
事件继续调用原有细粒度接口。快照按完整 URL 与实际账号隔离，聚合
不提供数据库事务快照。

## 调度与错误

- 同请求相同 GET（规范化查询顺序）复用 Promise，不跨请求保存私有数据。
- 最多 4 路并发，一般读取预算 5 秒，辅助模块 2 秒，视图总预算 8 秒。超时包括
  排队时间，取消后不启动排队任务，不自动重试。
- 身份、空间和主资源失败保留 HTTP 状态和诊断头；必须改密时跳转改密页。
  辅助模块失败独立呈现，401 不降级为匿名成功。
- 与既有代理共用客户端 IP/UA 规范化，JWT 仅在服务端注入。
- `Server-Timing` 提供耗时、Core 请求数、公共缓存状态与失败模块数，不含凭据。

## 公共元信息进程内缓存

匿名 `/api/v1/site/meta` 在 Nitro 服务端使用进程内 Map 缓存 30 秒，按上游 `apiBase`
隔离键，上游失败不缓存。域内容、身份、权限、成绩、通知和视图均不跨请求缓存，
保留 Core 的 no-store 约束，通用代理不启用 SWR。

## SSR 与验收

客户端页面在 `utils/ssr-routes.ts` 列出，由 Nuxt 配置转成 Nitro routeRules；页面
元数据不再使用无效的 `ssr: false`。内容页保持 SSR，空间错误态返回相应 HTTP
状态。

```bash
deno task test
deno task test:components
deno task check
deno task build
deno task test:bff:ssr
```

浏览器测试需要 Playwright
Chromium：`deno run -A npm:playwright@1.65.1 install chromium`。
验收启动独立模拟 Core 和生产构建，检查匿名/学生/域教练/普通成员、初始 HTML、HTTP
状态、水合零重复取数、SPA 单次 BFF 取数与局部刷新，不访问生产或修改真实 Core
数据。

题单只补齐当前页可用题目的题名和个人进度，不向来源域读取，不下发额外题面。摘要失败保留条目与作答链接，进度未知不计为未作答；统计明确标记为本页，不推算全题单完成率。共享设置由用户展开后读取。

作业编辑页及题目翻页使用
`GET /api/bff/v1/domains/:slug/problem-summaries?reference=1001&reference=1002`，最多20个引用，保留使用域授权与私有
no-store。此接口只返回题号、题名及读取失败标记，失败不回退来源域。
