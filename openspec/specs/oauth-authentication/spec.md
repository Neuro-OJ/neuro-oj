# oauth-authentication Specification

## Purpose

为 Neuro OJ 提供可配置的 GitHub 与通用 OIDC 第三方身份认证，同时将第三方身份安全地关联到本地用户，并继续使用现有的 JWT Cookie 会话体系。

## Requirements

### Requirement: Provider discovery and configuration

系统 SHALL 提供 `GET /api/v1/auth/oauth/providers`，返回当前已完整配置且可用的 provider 列表。每项至少包含稳定的 `id` 和用于展示的 `name`。未配置或配置不完整的 provider MUST 不出现在列表中，且其授权端点 MUST 返回 404 或明确的 provider 未启用错误。

GitHub provider SHALL 使用 `OAUTH_GITHUB_CLIENT_ID` 与 `OAUTH_GITHUB_CLIENT_SECRET`。OIDC provider SHALL 使用 `OAUTH_OIDC_ISSUER_URL`、`OAUTH_OIDC_CLIENT_ID`、`OAUTH_OIDC_CLIENT_SECRET`，并允许通过 `OAUTH_OIDC_NAME` 配置展示名称。

#### Scenario: Only configured providers are listed

- **WHEN** GitHub credentials are configured and OIDC credentials are absent
- **THEN** the provider list contains GitHub and does not contain OIDC

#### Scenario: Incomplete provider configuration is rejected

- **WHEN** a provider is missing any required credential
- **THEN** the provider is not listed and starting its authorization flow returns a provider-not-enabled error

### Requirement: Authorization redirect and callback

系统 SHALL 为每个可用 provider 提供 `GET /api/v1/auth/oauth/:provider` 授权跳转端点，以及 `GET /api/v1/auth/oauth/:provider/callback` 回调端点。

授权跳转 MUST 生成不可预测、短期有效且仅可使用一次的 `state`，并将其绑定到 HttpOnly、SameSite=Lax 的临时 Cookie。回调 MUST 同时验证 provider、state Cookie 与 query state；任一不匹配、缺失、过期或已消费时 MUST 拒绝登录，不得签发 JWT。OAuth 错误响应、provider 返回错误或 token/userinfo 交换失败 MUST 以安全错误重定向到前端，不得泄露 access token、client secret 或 provider 原始敏感响应。

#### Scenario: Authorization starts with a CSRF state

- **WHEN** an anonymous user requests an enabled provider authorization endpoint
- **THEN** the system redirects to the provider with a generated state and sets a short-lived HttpOnly state cookie

#### Scenario: State mismatch is rejected

- **WHEN** the callback query state differs from the state cookie
- **THEN** the system rejects the callback, does not create or log in a user, and does not issue a JWT

#### Scenario: State replay is rejected

- **WHEN** a previously successful callback state is submitted again
- **THEN** the system rejects the callback because the state has already been consumed

#### Scenario: Provider failure is handled safely

- **WHEN** the provider returns an OAuth error or the code exchange fails
- **THEN** the system redirects to the frontend with a generic login failure and does not expose provider credentials or tokens

### Requirement: Existing identity login and verified email matching

系统 SHALL persist each external identity using `(provider, provider_user_id)` as its stable key. A callback for an already-linked identity MUST log in the linked local user.

If no external identity matches, the system MAY match an existing local user only when the provider supplies a verified email address. A verified-email match MUST bind the external identity to that user and log the user in; an unverified or absent email MUST NOT automatically bind to an existing account.

#### Scenario: Linked identity logs in

- **WHEN** a valid callback resolves to an existing `(provider, provider_user_id)` record
- **THEN** the system signs a JWT for that local user and redirects to the frontend as an authenticated session

#### Scenario: Verified email binds an existing user

- **WHEN** a valid unlinked identity has a provider-verified email matching one local account
- **THEN** the system creates the external identity link, signs a JWT for that account, and redirects to the frontend as an authenticated session

#### Scenario: Unverified email cannot take over an account

- **WHEN** an unlinked identity has an absent or unverified email matching a local account
- **THEN** the system does not bind it automatically and reports that explicit authenticated linking is required

### Requirement: New OAuth user provisioning

当有效回调既没有已绑定身份也没有可安全匹配的本地账号时，系统 SHALL 创建本地用户和外部身份关联，并登录新用户。

新用户的用户名 MUST 在系统唯一；当 provider 用户名不可用或发生冲突时，系统 MUST 生成不泄露敏感信息且可重复修正的唯一用户名。新用户的本地密码可以为空，但用户 MUST 能够在已登录状态下通过密码设定端点补设密码。

#### Scenario: First OAuth login creates a user

- **WHEN** a valid provider identity is not linked and cannot be matched to an existing verified email
- **THEN** the system creates one local user, creates one external identity link, and establishes a JWT session

#### Scenario: Repeated callback does not duplicate the user

- **WHEN** the same provider identity is used again
- **THEN** the system reuses the existing local user and external identity rather than creating a second account

### Requirement: Authenticated linking and unlinking

系统 SHALL 提供已登录用户查看、绑定和解绑第三方身份的能力。绑定和解绑 MUST 要求有效登录态，并在用户已有本地密码时要求再次提交当前密码确认；密码校验失败 MUST 不改变任何关联关系。

系统 MUST 禁止解绑后失去所有登录方式：当用户没有本地密码且仅剩一个外部身份时，解绑 MUST 被拒绝。绑定回调不得把外部身份关联到另一个已登录用户。

#### Scenario: User links a provider

- **WHEN** an authenticated user confirms their password and completes a provider authorization flow
- **THEN** the provider identity is linked to that user and is visible in the account list

#### Scenario: Wrong password blocks linking

- **WHEN** the password confirmation for linking is invalid
- **THEN** the system rejects the operation and leaves all external identity links unchanged

#### Scenario: User unlinks a provider

- **WHEN** an authenticated user confirms their password and the account has another usable login method
- **THEN** the selected external identity is removed and other identities remain unchanged

#### Scenario: Last login method cannot be removed

- **WHEN** a user attempts to unlink their only external identity while their local password is empty
- **THEN** the system rejects the operation and keeps the identity linked

### Requirement: Password setup for OAuth-created users

系统 SHALL 提供受认证保护的密码设定端点，允许本地密码为空的用户提交符合现有密码强度规则的新密码。已有本地密码的用户 MUST 使用现有修改密码流程，不得通过设密端点绕过旧密码校验。

#### Scenario: OAuth user sets a local password

- **WHEN** an authenticated OAuth-created user submits a valid new password
- **THEN** the system stores a bcrypt hash, marks the account as having a local password, and returns the updated user information without exposing the hash

#### Scenario: Existing-password user cannot bypass confirmation

- **WHEN** a user with an existing local password calls the password setup endpoint
- **THEN** the system rejects the request and requires the normal change-password flow
