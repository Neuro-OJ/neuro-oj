## MODIFIED Requirements

### Requirement: 用户登录

系统 SHALL 提供 `POST /api/v1/auth/login` 端点，验证用户凭证并返回 JWT。

请求体：

- `login`（必填，string）：用户名或邮箱地址
- `password`（必填，string）：密码
- `code`（可选，string）：TFA 验证码或恢复码；用户已启用 TFA 时必填

响应：

- 成功：200，`{ "data": { "user": { "id", "username", "email", "role", "must_change_password", ... }, "token": "<jwt>" } }`（从 noj-core 直接调用时）
- 成功（通过 Nitro 代理）：200，`{ "data": { "user": { ... } } }`（token 字段被 Nitro 代理拦截并转为 Set-Cookie）
- 失败：400（验证失败或缺少 TFA code）或 401（凭证无效 / TFA 验证码错误）

JWT 负载 MUST 包含 `sub`（用户 ID）、`role`（用户角色）和 `must_change_password`（布尔），过期时间默认 24 小时。

为提高安全性，登录失败 MUST 返回统一消息
`"用户名或密码错误"`，不区分"用户不存在"和"密码错误"。

用户已启用 TFA 时，系统 MUST 在密码验证通过后继续校验 `code`；`code` 缺失时
MUST 返回 400 且错误码为 `TFA_REQUIRED`，`code` 错误时 MUST 返回 401 且不签发 JWT。

#### Scenario: 用用户名登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 提供有效的用户名和密码，且用户未启用 TFA
- **THEN** 系统验证密码，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 用用户名登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 提供有效的用户名和密码，且用户未启用 TFA
- **THEN** 代理将响应中的 `data.token` 提取为 HTTP-only Cookie `noj:token`，设置 readable cookie `noj:session`，移除响应体中的 `token` 字段，返回 200 和用户信息

#### Scenario: 用邮箱登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 的 `login`
  字段为已注册的邮箱地址，密码正确，且用户未启用 TFA
- **THEN** 系统按邮箱查找用户，验证密码，返回 200 和 JWT

#### Scenario: 用邮箱登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确，且用户未启用 TFA
- **THEN** 代理设置认证 cookie，返回用户信息（不含 token）

#### Scenario: 密码错误

- **WHEN** 客户端提供正确的用户名但错误的密码
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`，不设置任何 cookie

#### Scenario: 用户不存在

- **WHEN** 客户端提供不存在的用户名或邮箱
- **THEN** 系统返回 401，错误消息
  `"用户名或密码错误"`（与密码错误消息一致，防止用户枚举），不设置任何 cookie

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
