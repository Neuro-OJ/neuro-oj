## MODIFIED Requirements

### Requirement: 密码重置执行

系统 SHALL 提供 `POST /api/v1/auth/reset-password` 端点，接受 `token`（必填 string）
和 `new_password`（必填 string），用于执行密码重置。

**令牌验证（原子消耗）：**

- 系统 MUST 用 SHA-256 哈希提交的 token
- 系统 MUST 在单 SQL 中完成消耗：`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`
- affected rows = 0 → 令牌无效/过期/已用，系统返 400 `"重置令牌无效或已过期"`
- affected rows = 1 → 拿到 user_id，继续执行密码更新

**密码更新：**

- 密码 MUST 通过 `validatePasswordStrength()` 校验（≥8 字符 + 大小写字母 + 数字 + 不得与用户名/邮箱相同）
- 校验失败 MUST 返 400，**不消耗 token**（用户可重新请求）
- 校验通过 MUST 用 `hashPassword()` (bcrypt cost 12) 哈希后 UPDATE users 表

**成功响应：** `{ "ok": true, "message": "密码重置成功，请使用新密码登录" }`

#### Scenario: 合法令牌重置密码

- **WHEN** 客户端 POST `/api/v1/auth/reset-password` 携带 `{"token": "<有效 token>", "new_password": "<符合强度的新密码>"}`
- **THEN** 系统单 SQL 消耗 token 成功（affected = 1）
- **THEN** 系统 UPDATE users SET password_hash = bcrypt(new_password)
- **THEN** 系统返 200 和成功消息

#### Scenario: 重复提交同一 token

- **WHEN** 客户端两次 POST `/api/v1/auth/reset-password` 携带相同 token
- **THEN** 第一次返 200，token 标记为已用
- **THEN** 第二次 single SQL 命中 `used_at IS NULL` 失败，返 400 `"重置令牌无效或已过期"`

#### Scenario: 过期 token

- **WHEN** 客户端 POST `/api/v1/auth/reset-password` 携带一个 expires_at < now() 的 token
- **THEN** 系统 single SQL 命中 `expires_at > now()` 失败，返 400 `"重置令牌无效或已过期"`

#### Scenario: 弱密码

- **WHEN** 客户端 POST 携带 `{"token": "<有效>", "new_password": "short"}`
- **THEN** 系统 MUST 抛 `validatePasswordStrength()` 错误返 400
- **THEN** token MUST NOT 被消耗（用户可重新请求）

#### Scenario: 密码与用户名/邮箱相同

- **WHEN** 客户端 POST 携带 new_password 等于当前用户的 username 或 email 前缀
- **THEN** 系统返 400 错误
- **THEN** token MUST NOT 被消耗

#### Scenario: 缺少 token 或 new_password 字段

- **WHEN** 客户端 POST 不携带 token 或 new_password
- **THEN** 系统返 400 和错误消息 `"缺少字段 token"` 或 `"缺少字段 new_password"`

### Requirement: 修改密码端点

系统 SHALL 提供 `POST /api/v1/auth/change-password`，要求登录态。

请求体：

- `old_password`（必填，string）：用户当前密码（root 系统用户 id='0' 不可登录，理论上不应调用此端点）
- `new_password`（必填，string）：新密码，复用注册时强度规则（≥8 位、含大小写字母+数字、不能与 username/email 前缀相同）

响应：

- 成功：200，`{ "data": { ...user, "must_change_password": false } }`
- 失败：400（缺少字段或新密码强度不足）或 401（原密码错误）

成功后 MUST 更新 `password_hash` 并将 `must_change_password` 设为 `false`。

此端点 MUST 受登录速率限制（IP 维度）保护。

#### Scenario: 引导管理员首次改密成功

- **WHEN** `must_change_password=true` 的用户 POST `/api/v1/auth/change-password` 携带正确 `old_password` 和符合强度规则的 `new_password`
- **THEN** 系统更新密码哈希与 `must_change_password=false`，返回 200 与更新后的用户信息

#### Scenario: 原密码错误

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带错误的 `old_password`
- **THEN** 系统返回 401，错误消息 `"原密码错误"`，不修改数据库

#### Scenario: 新密码强度不足

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带 `new_password="123"`
- **THEN** 系统返回 400，错误消息指明密码不符合强度规则

#### Scenario: 缺少原密码

- **WHEN** 用户 POST `/api/v1/auth/change-password` 但请求体缺少 `old_password` 字段
- **THEN** 系统返回 400，错误消息 `"缺少原密码"`

#### Scenario: 速率限制保护

- **WHEN** 同一 IP 在 rate-limit 窗口内高频调用 `/api/v1/auth/change-password`
- **THEN** 系统返回 429
