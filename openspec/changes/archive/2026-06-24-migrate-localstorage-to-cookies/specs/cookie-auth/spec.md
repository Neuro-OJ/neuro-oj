## ADDED Requirements

### Requirement: Nitro 代理从 Cookie 注入 Authorization 头

Nitro 代理层（`server/api/[...slug].ts`）SHALL 在每次转发请求到 noj-core 时，检查请求中的 `noj:token` cookie。若存在，MUST 将 `Authorization: Bearer <token>` 头注入到转发请求中。

#### Scenario: 请求携带有效 token cookie
- **WHEN** 请求包含 `noj:token` cookie，值为有效的 JWT
- **THEN** Nitro 代理读取 cookie 值，添加 `Authorization: Bearer <cookie-value>` 头后转发到 noj-core

#### Scenario: 请求无 token cookie
- **WHEN** 请求不包含 `noj:token` cookie
- **THEN** Nitro 代理直接转发请求，不添加 Authorization 头

#### Scenario: Cookie 值特殊字符
- **WHEN** `noj:token` cookie 包含特殊字符（如点号、连字符等标准 JWT 字符）
- **THEN** Nitro 代理正确解码后注入，token 完整性不受影响

### Requirement: 登录时服务端设置 Cookie

Nitro 代理 SHALL 在用户登录成功时，拦截 noj-core 返回的响应体，从 `data.token` 字段提取 JWT，并在响应中设置 `Set-Cookie` 头。同时 SHALL 从响应体中移除 `token` 字段，避免 token 以 JSON 形式传到客户端。

#### Scenario: 登录成功设置 HTTP-only Cookie
- **WHEN** Nitro 代理收到 noj-core 对 `POST /api/v1/auth/login` 的 200 响应，包含 `{ data: { user, token } }`
- **THEN** 代理设置 `noj:token` 为 HTTP-only cookie（`HttpOnly; Path=/api; SameSite=Strict; Secure`），设置 `noj:session` 为可读 cookie（`Path=/; SameSite=Strict`），从响应体移除 `token` 字段，返回 `{ data: { user } }` 给客户端

#### Scenario: 登录失败不设置 Cookie
- **WHEN** noj-core 返回 400/401 登录失败响应
- **THEN** Nitro 代理不设置任何 cookie，透传错误响应给客户端

### Requirement: 登出时清除 Cookie

系统 SHALL 提供 `POST /api/auth/logout` 端点，清除客户端的认证 cookie。

#### Scenario: 登出成功
- **WHEN** 客户端 POST `/api/auth/logout`
- **THEN** 服务端返回 200，并在响应中清除 `noj:token` 和 `noj:session` cookie（`Set-Cookie: ...; Max-Age=0`）

### Requirement: Auth composable 使用 useCookie 管理登录状态

`useAuth` composable SHALL 使用 Nuxt 的 `useCookie("noj:session")` 在客户端追踪登录状态，取代 `localStorage`。

SSR 阶段，服务端 SHALL 根据 `noj:token` cookie 的存在情况预取用户信息，并通过 `useState` 注入到页面。

#### Scenario: SSR 时有 token cookie
- **WHEN** 页面请求携带 `noj:token` cookie，SSR 执行
- **THEN** 服务端读取 cookie，调用 `/api/v1/auth/me` 获取用户信息，将用户数据和 `loading=false` 通过 `useState` 注入页面 HTML，水合后客户端直接使用

#### Scenario: SSR 时无 token cookie
- **WHEN** 页面请求不携带 `noj:token` cookie
- **THEN** 服务端设置 `useState("auth:user") = null`，`loading = false`，客户端水合后显示未登录状态

#### Scenario: 客户端水合后登录
- **WHEN** 用户在客户端调用 `login()`
- **THEN** `$fetch` 请求由浏览器自动携带当前域 cookie，登录响应设置新 cookie，`useAuth` 在客户端更新 `useState`

#### Scenario: 客户端退出
- **WHEN** 用户调用 `logout()`
- **THEN** 客户端 POST `/api/auth/logout` 清除 cookie，重置 `useState` 为未登录状态

### Requirement: session cookie 内容规范

`noj:session` cookie SHALL 包含以下 JSON 序列化信息：`userId`、`username`、`role`。SHALL NOT 包含 token 或任何敏感凭证。

#### Scenario: 登录后 session cookie 内容
- **WHEN** 用户登录成功，服务端设置 `noj:session` cookie
- **THEN** cookie 值为 `{"userId":"<uuid>","username":"<name>","role":"<user|admin>"}`，不含 JWT 或密码

### Requirement: Cookie 安全属性

所有认证相关 cookie SHALL 设置以下安全属性：

- `noj:token`: `HttpOnly; Path=/api; SameSite=Strict; Secure`（生产环境）
- `noj:session`: `Path=/; SameSite=Strict`（生产环境 Secure）

#### Scenario: 开发环境不强制 Secure
- **WHEN** 应用在 `http://localhost` 开发模式下运行
- **THEN** `Secure` 标记不设置（或通过配置控制），允许本地开发
