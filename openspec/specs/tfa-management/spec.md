## Purpose

定义 TFA（TOTP）状态查询、启用设置、确认启用、禁用与恢复码重新生成的管理 API。

## Requirements

### Requirement: 查询 TFA 状态

系统 SHALL 在 `GET /api/v1/auth/me` 响应中返回当前用户的 `tfa_enabled` 字段，
用于前端展示 TFA 是否已启用。该字段 MUST 为布尔值，且 MUST 不暴露 TOTP secret 或
恢复码。

#### Scenario: 未启用 TFA 的用户查看状态

- **WHEN** 已登录且未启用 TFA 的用户调用 `GET /api/v1/auth/me`
- **THEN** 系统返回 `tfa_enabled: false`

#### Scenario: 已启用 TFA 的用户查看状态

- **WHEN** 已登录且已启用 TFA 的用户调用 `GET /api/v1/auth/me`
- **THEN** 系统返回 `tfa_enabled: true`

### Requirement: 生成 TOTP 设置信息

系统 SHALL 提供 `POST /api/v1/auth/tfa/setup` 端点，供已登录用户生成新的 TOTP
secret。端点 MUST 返回 `secret` 和 `otpauth_url`，MUST NOT 在响应中返回恢复码。
若用户已启用 TFA，端点 MUST 返回 400。

#### Scenario: 未启用 TFA 用户生成设置信息

- **WHEN** 已登录且未启用 TFA 的用户调用 `POST /api/v1/auth/tfa/setup`
- **THEN** 系统生成新的 TOTP secret，返回 200 和 `{ secret, otpauth_url }`

#### Scenario: 已启用 TFA 用户重复生成设置信息

- **WHEN** 已登录且已启用 TFA 的用户调用 `POST /api/v1/auth/tfa/setup`
- **THEN** 系统返回 400，且不修改现有 TFA 配置

### Requirement: 确认启用 TFA

系统 SHALL 提供 `POST /api/v1/auth/tfa/confirm` 端点，供已登录用户使用 6 位 TOTP
验证码确认启用。验证成功后，系统 MUST 将 `tfa_enabled` 置为 `true`，生成 10 个
一次性恢复码，并仅在本次响应中返回明文恢复码 `recovery_codes`。若未先调用 setup 或
验证码错误，端点 MUST 返回 400/401 且不启用。

#### Scenario: 验证码正确并启用成功

- **WHEN** 已登录用户先调用 `POST /api/v1/auth/tfa/setup`，再以正确 6 位验证码调用
  `POST /api/v1/auth/tfa/confirm`
- **THEN** 系统启用 TFA，返回 200 和 10 个明文恢复码

#### Scenario: 验证码错误

- **WHEN** 已登录用户以错误验证码调用 `POST /api/v1/auth/tfa/confirm`
- **THEN** 系统返回 401，且 `tfa_enabled` 保持 `false`

#### Scenario: 未先生成设置信息

- **WHEN** 已登录用户未调用 setup 直接调用 `POST /api/v1/auth/tfa/confirm`
- **THEN** 系统返回 400，且不启用 TFA

### Requirement: 禁用 TFA

系统 SHALL 提供 `POST /api/v1/auth/tfa/disable` 端点，供已登录用户禁用 TFA。
请求体 MUST 包含 `code`，接受 TOTP 验证码或恢复码。校验通过后，系统 MUST 将
`tfa_enabled` 置为 `false`、清除 `tfa_secret_encrypted`、删除该用户全部恢复码。
若使用恢复码，该恢复码 MUST 同时被消费。

#### Scenario: 使用 TOTP 验证码禁用成功

- **WHEN** 已启用 TFA 的用户以正确 TOTP 验证码调用 `POST /api/v1/auth/tfa/disable`
- **THEN** 系统禁用 TFA，清除 secret 和恢复码，返回成功

#### Scenario: 使用恢复码禁用成功

- **WHEN** 已启用 TFA 的用户以未使用恢复码调用 `POST /api/v1/auth/tfa/disable`
- **THEN** 系统禁用 TFA，清除 secret 和恢复码，并消费该恢复码

#### Scenario: 验证码错误

- **WHEN** 已启用 TFA 的用户以错误验证码调用 `POST /api/v1/auth/tfa/disable`
- **THEN** 系统返回 401，TFA 配置保持不变

### Requirement: 重新生成恢复码

系统 SHALL 提供 `POST /api/v1/auth/tfa/recovery-codes/regenerate` 端点，供已启用
TFA 的用户重新生成 10 个恢复码。请求体 MUST 包含 `code`，接受 TOTP 验证码或恢复码。
成功后，系统 MUST 作废该用户所有旧恢复码，并返回新的 10 个明文恢复码。若使用恢复码，
该恢复码 MUST 同时被消费。

#### Scenario: 使用 TOTP 验证码重新生成成功

- **WHEN** 已启用 TFA 的用户以正确 TOTP 验证码调用
  `POST /api/v1/auth/tfa/recovery-codes/regenerate`
- **THEN** 系统作废旧恢复码，返回新的 10 个明文恢复码

#### Scenario: 使用恢复码重新生成成功

- **WHEN** 已启用 TFA 的用户以未使用恢复码调用
  `POST /api/v1/auth/tfa/recovery-codes/regenerate`
- **THEN** 系统作废旧恢复码，消费当前恢复码，返回新的 10 个明文恢复码

#### Scenario: 验证码错误

- **WHEN** 已启用 TFA 的用户以错误验证码调用
  `POST /api/v1/auth/tfa/recovery-codes/regenerate`
- **THEN** 系统返回 401，恢复码保持不变
