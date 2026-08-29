## ADDED Requirements

### Requirement: 用户管理第三方账号绑定

系统 SHALL 在设置页提供当前用户已绑定第三方身份列表，并提供受认证保护的绑定、解绑操作。列表 MUST 只返回 provider 标识、展示名称、provider 用户标识的脱敏摘要和绑定时间，不得返回 access token、refresh token、client secret 或其他 provider 凭证。

#### Scenario: Settings lists linked accounts

- **WHEN** an authenticated user opens the account settings
- **THEN** the UI loads the linked provider list and shows only configured providers as available link targets

#### Scenario: Unauthenticated settings access is rejected

- **WHEN** an unauthenticated client requests the linked-account API
- **THEN** the system returns HTTP 401

#### Scenario: Link and unlink errors are shown safely

- **WHEN** a link or unlink operation fails due to password confirmation, provider conflict, or last-login-method protection
- **THEN** the UI shows a user-readable error without rendering provider tokens or secret values
