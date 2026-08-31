## MODIFIED Requirements

### Requirement: 用户登录

系统 SHALL 提供 `POST /api/v1/auth/login` 端点，验证本地用户凭证并返回 JWT。除本地密码登录外，系统 SHALL 通过 OAuth/OIDC 回调为已链接或新建的用户签发同一 JWT 会话；OAuth 回调不得要求客户端接收 access token。

请求体：

- `login`（必填，string）：用户名或邮箱地址
- `password`（必填，string）：本地密码登录时必填
- `code`（可选，string）：TFA 验证码或恢复码；用户已启用 TFA 时必填

密码为空的 OAuth 用户 MUST 不能通过本地密码登录，且错误响应 MUST 与普通凭证错误保持一致。

#### Scenario: 用用户名登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 提供有效的用户名和密码，且用户未启用 TFA
- **THEN** 系统验证密码，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 用邮箱登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确，且用户未启用 TFA
- **THEN** 系统按邮箱查找用户，验证密码，返回 200 和 JWT

#### Scenario: 用用户名登录成功（通过 Nitro 代理）

- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 提供有效的用户名和密码，且用户未启用 TFA
- **THEN** 代理将响应中的 `data.token` 提取为 HTTP-only Cookie `noj:token`，设置 readable cookie `noj:session`，移除响应体中的 `token` 字段，返回 200 和用户信息

#### Scenario: 用邮箱登录成功（通过 Nitro 代理）

- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确，且用户未启用 TFA
- **THEN** 代理设置认证 cookie，返回用户信息（不含 token）

#### Scenario: 密码错误

- **WHEN** 客户端提供正确的用户名但错误的密码
- **THEN** 系统返回 401，错误消息为统一凭证错误，不设置任何 cookie

#### Scenario: 用户不存在

- **WHEN** 客户端提供不存在的用户名或邮箱
- **THEN** 系统返回 401，错误消息与密码错误一致，不设置任何 cookie

#### Scenario: 已启用 TFA 但未提供验证码

- **WHEN** 已启用 TFA 的用户以正确密码调用 `POST /api/v1/auth/login`，但请求体不含 `code`
- **THEN** 系统返回 400，错误码 `TFA_REQUIRED`，不签发 JWT、不设置 cookie

#### Scenario: 已启用 TFA 且 TOTP 验证码正确

- **WHEN** 已启用 TFA 的用户以正确密码和正确 6 位 TOTP 验证码调用 `POST /api/v1/auth/login`
- **THEN** 系统校验通过，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 已启用 TFA 且 TOTP 验证码错误

- **WHEN** 已启用 TFA 的用户以正确密码但错误 TOTP 验证码调用 `POST /api/v1/auth/login`
- **THEN** 系统返回 401，不签发 JWT、不设置 cookie

#### Scenario: 已启用 TFA 且恢复码正确

- **WHEN** 已启用 TFA 的用户以正确密码和未使用恢复码调用 `POST /api/v1/auth/login`
- **THEN** 系统校验通过并消费该恢复码，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 已启用 TFA 且恢复码已使用

- **WHEN** 已启用 TFA 的用户以正确密码但已使用过的恢复码调用 `POST /api/v1/auth/login`
- **THEN** 系统返回 401，不签发 JWT、不设置 cookie

#### Scenario: 密码为空的 OAuth 用户不能本地登录

- **WHEN** 密码为空的 OAuth 用户调用本地登录端点
- **THEN** 系统返回统一的 401 凭证错误，不签发 JWT

#### Scenario: OAuth 回调登录成功

- **WHEN** 客户端完成有效的 GitHub 或 OIDC 回调
- **THEN** 系统签发与本地登录相同的 JWT 会话并重定向到前端

### Requirement: 获取当前用户信息

系统 SHALL 提供 `GET /api/v1/auth/me` 端点，返回当前认证用户的完整信息。响应 MUST 明确反映该用户是否已设置本地密码，并可供设置页展示其已绑定的第三方身份。

此端点 MUST 受 JWT 中间件保护。请求 MUST 包含有效的 `Authorization: Bearer <token>` 头（从 noj-core 直接调用时）；通过 Nitro 代理调用时，token 由代理从 `noj:token` cookie 自动注入。

响应：

- 成功：200，`{ "data": { "id", "username", "email", "must_change_password", "has_local_password", "tfa_enabled", "created_at", "updated_at" } }`
- 失败：401（未认证或令牌无效）

#### Scenario: 获取当前用户信息

- **WHEN** 客户端 GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** 系统解析 token 中的用户 ID，从数据库查询用户信息，返回 200 和用户数据（不含 password_hash）

#### Scenario: 获取当前用户信息（通过 Nitro 代理）

- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求携带有效的 `noj:token` cookie
- **THEN** 代理自动注入 `Authorization: Bearer <token>` 头转发到 noj-core，返回 200 和用户数据

#### Scenario: 获取当前用户信息（直接调用 noj-core）

- **WHEN** API 客户端直接调用 noj-core GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** noj-core 返回 200 和用户数据（行为不变）

#### Scenario: 无认证令牌

- **WHEN** 客户端 GET `/api/v1/auth/me` 未提供 Authorization 头
- **THEN** 系统返回 401，错误消息为未提供认证令牌

#### Scenario: 无 token cookie

- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求无 `noj:token` cookie
- **THEN** 代理不添加 Authorization 头，noj-core 返回 401

#### Scenario: 令牌无效或已过期

- **WHEN** 客户端 GET `/api/v1/auth/me` 提供的 JWT 签名无效或已过期
- **THEN** 系统返回 401，错误消息为认证令牌无效或已过期

#### Scenario: OAuth user profile reports password state

- **WHEN** a passwordless OAuth-created user requests `/api/v1/auth/me` with a valid JWT
- **THEN** the response contains `has_local_password: false` and excludes `password_hash`

#### Scenario: Local user profile remains compatible

- **WHEN** a local-password user requests `/api/v1/auth/me` with a valid JWT
- **THEN** the response contains `has_local_password: true` and retains the existing public user fields

### Requirement: 修改密码端点

系统 SHALL 保留现有 `POST /api/v1/auth/change-password` 端点及其旧密码确认、密码强度校验和新 token 签发行为。对于本地密码为空的 OAuth 用户，该端点 MUST 返回要求使用密码设定流程的业务错误，不得把空密码当作有效旧密码。

#### Scenario: 引导管理员首次改密成功

- **WHEN** `must_change_password=true` 的用户 POST `/api/v1/auth/change-password` 携带正确 `old_password` 和符合强度规则的 `new_password`
- **THEN** 系统更新密码哈希与 `must_change_password=false`，返回 200 与更新后的用户信息

#### Scenario: 原密码错误

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带错误的 `old_password`
- **THEN** 系统返回 401，错误消息为原密码错误，不修改数据库

#### Scenario: 新密码强度不足

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带不符合强度规则的 `new_password`
- **THEN** 系统返回 400，错误消息指明密码不符合强度规则

#### Scenario: 缺少原密码

- **WHEN** 用户 POST `/api/v1/auth/change-password` 但请求体缺少 `old_password` 字段
- **THEN** 系统返回 400，错误消息为缺少原密码

#### Scenario: 速率限制保护

- **WHEN** 同一 IP 在 rate-limit 窗口内高频调用 `/api/v1/auth/change-password`
- **THEN** 系统返回 429

#### Scenario: Passwordless OAuth user is directed to setup

- **WHEN** an OAuth-created user without a local password calls change-password
- **THEN** the system rejects the request with a distinct password-setup-required error and does not change the account

#### Scenario: Existing local password change is unchanged

- **WHEN** a user with a local password submits the correct old password and a valid new password
- **THEN** the system performs the existing password change behavior and returns updated user information
