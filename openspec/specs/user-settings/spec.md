## Purpose

定义用户个人资料设置相关 API 规范，允许已登录用户修改自己的个人简介（bio）。API 路径前缀为 `/api/v1/users`，需要认证。

## Requirements

### Requirement: 用户可更新自己的个人简介

系统 SHALL 提供 `PUT /api/v1/users/me` 端点，允许已登录用户更新自己的 `bio` 字段。

此端点 SHALL 需要认证（Bearer Token）。

#### Scenario: 用户成功更新 bio

- **WHEN** 已登录用户发送 `PUT /api/v1/users/me`，JSON body 包含 `{"bio": "## 关于我\n\n算法竞赛爱好者"}`
- **THEN** 系统更新该用户的 bio 字段，返回 200 与更新后的用户信息

#### Scenario: 未登录用户尝试更新

- **WHEN** 未认证用户发送 `PUT /api/v1/users/me`
- **THEN** 系统返回 HTTP 401

#### Scenario: bio 超长

- **WHEN** 用户发送 `PUT /api/v1/users/me`，bio 超过 5000 字
- **THEN** 系统返回 HTTP 400，提示 "bio 长度不能超过 5000 字"

#### Scenario: 清除 bio

- **WHEN** 已登录用户发送 `PUT /api/v1/users/me`，JSON body 包含 `{"bio": ""}`
- **THEN** 系统将 bio 清空为 `""`，返回 200

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
