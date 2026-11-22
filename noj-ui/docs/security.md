# 安全：身份、代理与富文本净化

规则见 [AGENTS.md](../AGENTS.md) §1；本文给机制、边界与回归证据。

## 安全模型

| 机制           | 说明                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| JWT 存储       | HTTP-only Cookie（`noj:token`），JS 不可读，防 XSS 窃取                                                                     |
| Session Cookie | `noj:session`，`httpOnly: false`，仅用于 UI 快速判断登录态（**不可信任**，实际鉴权由后端执行）                              |
| CSRF 防护      | `sameSite: "lax"` 提供基础防护                                                                                              |
| 速率限制       | **未实现**（无 IP 封禁 / CAPTCHA）                                                                                          |
| 错误信息       | 后端错误信息直接展示给用户（`e.data?.error`）                                                                               |
| 管理路由       | `/admin/*` 在客户端 bundle 中可见，非管理员静默重定向到 `/`                                                                 |
| 富文本净化     | 服务端用**解析型** `sanitize-html`（政策见 `utils/sanitize-policy.ts`），客户端用 DOMPurify；**禁止用正则净化服务端富文本** |

Cookie 名默认 `noj:token` / `noj:session`，可用 `NUXT_PUBLIC_AUTH_COOKIE_PREFIX`
统一改前缀 （[build.md](build.md)）；服务端代理、登录、改密、401
清理与注销共用同一份配置。

## 域隔离

- 使用域只能来自 URL（`/d/:slug/...`），不得由 JWT、Cookie
  或导航偏好推导；资源网址与 缓存键必须包含使用域。
- 切换域或账号后，确认过的操作仍须复查目标空间与账号未改变；可读 Session Cookie
  不授予 任何域权限。
- 新域资源入口在全链路隔离验收前，不得直接接到旧全局业务 API。细节见
  [workspace.md](workspace.md)。

## 代理实现（`server/api/[...slug].ts`）

通用代理承接除视图 BFF 以外的页面（BFF
只覆盖空间首页、班级概览、作业详情与题单详情， 见 [bff.md](bff.md)）。代理职责：

- 只拦截两个端点：`POST /api/v1/auth/login` 与
  `POST /api/v1/auth/change-password` （证据 `server/api/[...slug].ts` 的
  `shouldInterceptAuth()`）。二者都解析响应、把 JWT 写进 HTTP-only
  Cookie，并从响应体删除 `token` 字段；改密后不重设 Cookie 会让旧 JWT 残留，
  导致路由守卫死循环。
- 登录响应为 `TFA_REQUIRED`（已启用 TFA 但缺 `code`）时没有 `token`，代理不设
  Cookie，前端据此 展示第二步验证码输入框。
- 注册等其他认证端点**不拦截**。
- 非登录请求：从 Cookie 读 `noj:token`，注入 `Authorization: Bearer` 后
  `proxyRequest()`。
- 路径白名单：只透传 `/api/v1/` 前缀，其余返回 404。
- 错误处理：捕获 `$fetch.raw` 抛出的 `err.response`，原样转发状态码与
  body；白名单响应头
  （`retry-after`、`x-ratelimit-*`、`x-request-id`、`www-authenticate`）透传给客户端。
- 注销走 `server/api/auth/logout.post.ts`：先通知后端撤销本套件
  token，再删本套件的两个 Cookie。

## 富文本净化硬规则

1. **不得用正则承担服务端 HTML 净化的安全职责**。实体解码必须交给 HTML 解析器：
   `javascript&#58alert(1)` / `javascript&#x3Aalert(1)`
   这类省略分号的数字实体，正则解码器
   要么漏解、要么在协议判定之前就解码，两者都会产出可执行的 `javascript:` 链接。
2. 新增富文本入口（Markdown、评论、题面、公告、邮件正文等）必须复用
   `utils/sanitize-policy.ts` 的政策；服务端与客户端的差异只能出现在
   `imagePolicy` / `afterSanitizeAttributes` 这一层，不得各写一套标签白名单。
3. 净化失败一律**降级纯文本**（fail-closed），不得输出未净化的 HTML。
4. 载荷回归语料只有一份：`tests/fixtures/xss-corpus.ts`。新增绕过手法必须同时加进语料，
   并跑齐三层证据：Deno 单测 + 组件测试 + `deno task test:bff:ssr`（真实
   Chromium）。

## 密码重置页

- `/forgot-password`：输入注册邮箱 → 显示"邮件已发送"绿色 banner。
- `/reset-password`：URL `?token=...` → 新密码 + 确认 → 跳 `/login?reset=1`。

实现约定：

- 两页 `definePageMeta({ layout: "auth" })`，与 login / register 同布局。
- 完全仿 `login.vue` / `register.vue`：Lucide 图标 + Tailwind utility +
  Transition banner。
- `useAuth()` 提供 `forgotPassword(email)` 与
  `resetPassword(token, newPassword)`。
- `middleware/auth.ts` 顶部 `PUBLIC_AUTH_PATHS` 白名单含这两条路径。
- 错误态复用 `setError` + 自动消失（重置页 5000 ms，其余 3000 ms）；重置成功跳
  `/login?reset=1`，`login.vue` 读 `route.query.reset === "1"` 显示成功 banner。

安全约束：

- 前端**不**判断邮箱是否存在（服务端防枚举：统一 200 + 同一消息）。
- token 只从 URL `?token=...` 读取并透传给后端；不在前端打印、缓存或上报。
