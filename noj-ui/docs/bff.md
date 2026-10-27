# 视图 BFF 与 SSR

Nitro 在 Nuxt 工程内聚合既有 Core API。Core 继续负责身份、业务授权和数据读取， BFF 不访问 Core 数据库，不增加 Core
API，不允许客户端任意指定上游路径。

## 首批视图

| 页面                 | GET 接口                                                          |
| -------------------- | ----------------------------------------------------------------- |
| 空间首页 `/d/:slug`  | `/api/bff/v1/domains/:slug/home`                                  |
| 班级概览             | `/api/bff/v1/domains/:slug/classrooms/:classroomId/overview`      |
| 题单详情（每页20题） | `/api/bff/v1/domains/:slug/trainings/:trainingId/overview?page=1` |
| 作业详情             | `/api/bff/v1/domains/:slug/assignments/:assignmentId/overview`    |

信封包含 `kind`、经 Core 验证的 `viewer`、`workspace` 和 `sections`。模块结构为 `{ data: <原接口响应> }` 或
`{ error: { statusCode, data: { error, code?, request_id? } } }`。 模块名与类型见
`utils/bff-view.ts`。作业详情包含当前角色可见的成绩、反馈和求助， 以及 `help`、`feedback`、`history=1`
通知深链指定的初始内容。

全局 `00-bff.global.ts` 现在是空操作：它不在导航阶段预取视图，也不向共享异步键 写入私有快照。每个页面自己调用 BFF 并拥有
`useAsyncData` 的 key、AbortSignal 和 首屏 DTO；历史名称 `useViewAsyncData` 只是 `useAsyncData` 的兼容包装。这样 SSR
结果由同一个页面数据键进入 Nuxt payload，水合不会把旧页面的响应注入新页面；刷新、 分页、筛选和 SSE
事件继续调用原有细粒度接口。快照按完整 URL 与实际账号隔离，聚合 不提供数据库事务快照。

## 调度与错误

- 同请求相同 GET（规范化查询顺序）复用 Promise，不跨请求保存私有数据。
- 最多 4 路并发，一般读取预算 5 秒，辅助模块 2 秒，视图总预算 8 秒。超时包括
  排队时间，取消后不启动排队任务，不自动重试。
- 身份、空间和主资源失败保留 HTTP 状态和诊断头；必须改密时跳转改密页。 辅助模块失败独立呈现，401 不降级为匿名成功。
- 与既有代理共用客户端 IP/UA 规范化，JWT 仅在服务端注入。
- `Server-Timing` 提供耗时、Core 请求数、公共缓存状态与失败模块数，不含凭据。

## Redis 公共缓存

| 环境变量                | 默认值          | 含义                            |
| ----------------------- | --------------- | ------------------------------- |
| `NUXT_BFF_REDIS_URL`    | 空              | 服务端 Redis 连接，空值禁用缓存 |
| `NUXT_BFF_CACHE_PREFIX` | `noj:ui:bff:v1` | 部署命名空间                    |

生产 Compose 为 UI 注入现有 Redis 连接。键包含前缀与上游摘要，共享 Redis 的独立 部署使用不同前缀。只缓存匿名
`/api/v1/site/meta`，TTL 30 秒，Redis 锁合并填充。 Redis
不可用时快速绕过缓存。域内容、身份、权限、成绩、通知、关注动态和视图均不 跨请求缓存，保留 Core 的 no-store
约束，通用代理不启用 SWR。

## SSR 与验收

客户端页面在 `utils/ssr-routes.ts` 列出，由 Nuxt 配置转成 Nitro routeRules；页面 元数据不再使用无效的
`ssr: false`。内容页保持 SSR，空间错误态返回相应 HTTP 状态。

```bash
deno task test
deno task test:components
deno task check
deno task build
deno task test:bff:ssr
```

浏览器测试需要 Playwright Chromium：`deno run -A npm:playwright install chromium`。 验收启动独立模拟 Core
和生产构建，检查匿名/学生/域教练/普通成员、初始 HTML、HTTP 状态、 水合零重复取数、SPA 单次 BFF
取数与局部刷新，不访问生产或修改真实 Core 数据。

共享缓存验收使用独立本机 Redis：

```bash
BFF_TEST_REDIS_URL=redis://127.0.0.1:6379 deno task test:bff:cache
```

该任务启动两个生产 UI 副本验证同一元信息缓存，并检查 30 秒 TTL 与 Redis 连接
失败时的回源。只清理随机测试命名空间，不清空 Redis。

题单只补齐当前页可用题目的题名和个人进度，不向来源域读取，不下发额外题面。摘要失败保留条目与作答链接，进度未知不计为未作答；统计明确标记为本页，不推算全题单完成率。共享设置由用户展开后读取。

作业首屏同时提供前20题的题名摘要。编辑页及题目翻页使用
`GET /api/bff/v1/domains/:slug/problem-summaries?reference=1001&reference=1002`，最多20个引用，保留使用域授权与私有
no-store。此接口只返回题号、题名及读取失败标记，失败不回退来源域。

## 学习流程的真实本机验收

`deno task test:learning:browser` 使用已有本机测试数据，要求显式设置 `E2E_UI_URL` 和 `E2E_ADMIN_PASS`（账号默认为
`e2e_admin`），拒绝远端地址。 任务只登录、读取页面、切换筛选/摘要与修改未保存的简介，不提交业务修改。 截图默认保存到
`/tmp/noj-learning-browser`，可由 `BROWSER_ARTIFACT_DIR` 指定。
覆盖1440/768/390px、认证默认状态、登录后页面、题名进度、账号锚点保留输入及键盘展开学生。 独立模拟 Core 的 `test:bff:ssr`
则覆盖角色分支、水合零重复请求、40人摘要和局部刷新。
