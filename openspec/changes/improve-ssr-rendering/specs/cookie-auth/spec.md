## ADDED Requirements

### Requirement: SSR 认证状态基于真实 token 校验

当请求携带 `noj:session` cookie 时，SSR 阶段 SHALL 通过服务端请求 `/api/v1/auth/me`（使用转发 Cookie 的 `useRequestFetch`）获取完整用户信息与权限，并写入 `useState`；不得仅凭可读 session cookie 映射的局部用户信息作为最终登录态。

#### Scenario: SSR 时 session cookie 有效

- **WHEN** 页面请求携带有效的 `noj:session` 与 `noj:token` cookie，SSR 执行
- **THEN** 服务端调用 `/api/v1/auth/me` 获取完整用户状态（含 `created_at`、`permissions`），写入 `useState`，客户端水合后直接复用，无需二次刷新

#### Scenario: SSR 时 token 已失效

- **WHEN** 页面请求携带 session cookie 但 token 已失效
- **THEN** SSR 按未登录处理，不渲染受保护的内容，客户端守卫随后跳转登录页

#### Scenario: SSR 时无 cookie

- **WHEN** 页面请求不携带认证 cookie
- **THEN** 服务端设置 `useState("auth:user") = null`，`loading = false`，客户端水合后显示未登录状态

## MODIFIED Requirements

### Requirement: Auth composable 使用 useCookie 管理登录状态

`useAuth` composable SHALL 使用 Nuxt 的 `useCookie("noj:session")` 在客户端追踪登录状态，取代 `localStorage`。

SSR 阶段，服务端 SHALL 在检测到 `noj:session` cookie 时调用 `/api/v1/auth/me` 获取完整用户信息，并通过 `useState` 注入到页面；认证失败时 SHALL 按未登录状态处理。

#### Scenario: SSR 时有 session cookie

- **WHEN** 页面请求携带 `noj:session` cookie，SSR 执行
- **THEN** 服务端通过 `/api/v1/auth/me` 获取完整用户信息并设置 `useState`，水合后客户端直接使用

#### Scenario: SSR 时无 session cookie

- **WHEN** 页面请求不携带 `noj:session` cookie
- **THEN** 服务端设置 `useState("auth:user") = null`，`loading = false`，客户端水合后显示未登录状态

#### Scenario: 客户端水合后登录

- **WHEN** 用户在客户端调用 `login()`
- **THEN** `$fetch` 请求由浏览器自动携带当前域 cookie，登录响应设置新 cookie，`useAuth` 在客户端更新 `useState`

#### Scenario: 客户端退出

- **WHEN** 用户调用 `logout()`
- **THEN** 客户端 POST `/api/auth/logout` 清除 cookie，重置 `useState` 为未登录状态
