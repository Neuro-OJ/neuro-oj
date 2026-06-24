## MODIFIED Requirements

### Requirement: 用户登录

系统 SHALL 提供 `POST /api/v1/auth/login` 端点，验证用户凭证并返回 JWT。

请求体：

- `login`（必填，string）：用户名或邮箱地址
- `password`（必填，string）：密码

响应：

- 成功：200，`{ "data": { "user": { ... }, "token": "<jwt>" } }`（从 noj-core 直接调用时）
- 成功（通过 Nitro 代理）：200，`{ "data": { "user": { ... } } }`（token 字段被 Nitro 代理拦截并转为 Set-Cookie）
- 失败：400（验证失败）或 401（凭证无效）

JWT 负载 MUST 包含 `sub`（用户 ID）和 `role`（用户角色），过期时间默认 24 小时。

为提高安全性，登录失败 MUST 返回统一消息
`"用户名或密码错误"`，不区分"用户不存在"和"密码错误"。

#### Scenario: 用用户名登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 提供有效的用户名和密码
- **THEN** 代理将响应中的 `data.token` 提取为 HTTP-only Cookie `noj:token`，设置 readable cookie `noj:session`，移除响应体中的 `token` 字段，返回 200 和用户信息

#### Scenario: 用邮箱登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确
- **THEN** 代理设置认证 cookie，返回用户信息（不含 token）

#### Scenario: 密码错误
- **WHEN** 客户端提供正确的用户名但错误的密码
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`，不设置任何 cookie

#### Scenario: 用户不存在
- **WHEN** 客户端提供不存在的用户名或邮箱
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`（与密码错误消息一致，防止用户枚举），不设置任何 cookie

### Requirement: 获取当前用户信息

系统 SHALL 提供 `GET /api/v1/auth/me` 端点，返回当前认证用户的完整信息。

此端点 MUST 受 JWT 中间件保护。请求 MUST 包含有效的 `Authorization: Bearer <token>` 头（从 noj-core 直接调用时）。通过 Nitro 代理调用时，token 由代理从 `noj:token` cookie 自动注入。

响应：

- 成功：200，`{ "data": { "id", "username", "email", "role", "created_at", "updated_at" } }`
- 失败：401（未认证或令牌无效）

#### Scenario: 获取当前用户信息（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求携带有效的 `noj:token` cookie
- **THEN** 代理自动注入 `Authorization: Bearer <token>` 头转发到 noj-core，noj-core 验证通过，返回 200 和用户数据；代理透传响应给客户端

#### Scenario: 获取当前用户信息（直接调用 noj-core）
- **WHEN** API 客户端直接调用 noj-core GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** noj-core 返回 200 和用户数据（行为不变）

#### Scenario: 无 token cookie
- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求无 `noj:token` cookie
- **THEN** 代理转发请求时不添加 Authorization 头，noj-core 返回 401，代理透传 401 给客户端

### Requirement: JWT 认证中间件

系统 SHALL 提供认证中间件，用于保护需要认证的路由。

中间件 MUST 执行以下流程：

1. 从请求头提取 `Authorization: Bearer <token>`（Nitro 代理已从 cookie 注入，或客户端直接提供）
2. 使用 `JWT_SECRET` 验证令牌签名和有效期
3. 验证成功后，将 `userId` 和 `userRole` 写入请求上下文
4. 验证失败时，返回 401 和适当的错误消息

默认 JWT 过期时间 SHALL 为 24 小时，可通过 `JWT_EXPIRES_IN` 环境变量配置。
