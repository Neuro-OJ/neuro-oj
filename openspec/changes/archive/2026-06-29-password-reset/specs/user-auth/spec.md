## Purpose

扩展用户认证规范，添加密码重置流程：基于邮件令牌的两阶段流程（请求重置 + 重置密码），
防邮箱枚举、令牌哈希存、15 分钟 TTL、一次性消耗。

## ADDED Requirements

### Requirement: 密码重置请求

系统 SHALL 提供 `POST /api/v1/auth/forgot-password` 端点，接受 `email` 字段（必填 string），
用于发起密码重置流程。

**防枚举行为**：

- 不管邮箱是否已注册，接口 MUST 统一返 200 + 同一响应消息：`{ "ok": true, "message": "如果该邮箱已注册，您将收到一封密码重置邮件" }`
- 邮箱存在时 MUST 实际生成令牌并发送邮件（mock 模式：控制台日志）
- 邮箱不存在或格式非法时 MUST 不发送邮件，但响应一致

**令牌生成**：

- 32 字节随机数 MUST 由 `crypto.getRandomValues()` 生成
- 明文令牌 MUST 用 base64url 编码（43 字符），包含在邮件链接中
- DB 存储 MUST 是 SHA-256 hex 哈希，**不存明文**

**令牌有效期**：15 分钟（MUST，与 OWASP 2025+ 一致）

#### Scenario: 已注册邮箱请求重置

- **WHEN** 已注册用户 POST `/api/v1/auth/forgot-password` 携带 `{"email": "<其注册邮箱>"}`
- **THEN** 系统生成 32 字节 base64url 令牌，计算 SHA-256 哈希
- **THEN** 系统在 `password_reset_tokens` 表插入新行（user_id FK CASCADE、token_hash UNIQUE、expires_at = now + 15min、used_at = NULL）
- **THEN** 系统调用 `sendPasswordResetEmail()`（mock 模式打印到 stdout）
- **THEN** 系统返 200 和统一消息

#### Scenario: 未注册邮箱请求重置

- **WHEN** 任意邮箱 POST `/api/v1/auth/forgot-password` 携带 `{"email": "<未注册邮箱>"}`
- **THEN** 系统 MUST 不创建 token 行
- **THEN** 系统 MUST 不发送邮件
- **THEN** 系统返 200 和**完全相同**的响应消息（防邮箱枚举）

#### Scenario: 缺少 email 字段

- **WHEN** 客户端 POST `/api/v1/auth/forgot-password` 不携带 email
- **THEN** 系统返 400 和错误消息 `"缺少字段 email"`

### Requirement: 密码重置执行

系统 SHALL 提供 `POST /api/v1/auth/reset-password` 端点，接受 `token`（必填 string）
和 `new_password`（必填 string），用于执行密码重置。

**令牌验证（原子消耗）**：

- 系统 MUST 用 SHA-256 哈希提交的 token
- 系统 MUST 在单 SQL 中完成消耗：`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`
- affected rows = 0 → 令牌无效/过期/已用，系统返 400 `"重置令牌无效或已过期"`
- affected rows = 1 → 拿到 user_id，继续执行密码更新

**密码更新**：

- 密码 MUST 通过 `validatePasswordStrength()` 校验（≥12 字符 + 大小写字母 + 数字 + 不得与用户名/邮箱相同）
- 校验失败 MUST 返 400，**不消耗 token**（用户可重新请求）
- 校验通过 MUST 用 `hashPassword()` (bcrypt cost 12) 哈希后 UPDATE users 表

**成功响应**：`{ "ok": true, "message": "密码重置成功，请使用新密码登录" }`

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

### Requirement: 邮件后端

系统 SHALL 提供 `sendPasswordResetEmail(email, resetLink)` 函数，Phase 1 实现为 mock 模式：
MUST 在 stdout 打印完整记录 `{ to, link, expiresIn }`（生产环境后续接 Resend/SMTP）。

#### Scenario: Mock 邮件输出

- **WHEN** `sendPasswordResetEmail("user@example.com", "http://localhost:3000/reset-password?token=...")` 被调用
- **THEN** stdout 输出一行包含 email、完整 link、"15 minutes" 字样的日志
