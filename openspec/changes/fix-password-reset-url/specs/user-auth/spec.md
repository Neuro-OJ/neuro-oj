## MODIFIED Requirements

### Requirement: 密码重置请求

系统 SHALL 提供 `POST /api/v1/auth/forgot-password` 端点，接受 `email` 字段（必填 string），用于发起密码重置流程。

**防枚举行为：**

- 不管邮箱是否已注册，接口 MUST 统一返 200 + 同一响应消息：`{ "ok": true, "message": "如果该邮箱已注册，您将收到一封密码重置邮件" }`
- 邮箱存在且可信的应用基础 URL 可用时 MUST 实际生成令牌并发送邮件（mock 模式：控制台日志）
- 邮箱不存在或格式非法时 MUST 不发送邮件，但响应一致
- `APP_URL` 配置为空时，`NOJ_ENV=production` 环境 MUST 不生成令牌、不发送邮件，并记录内部错误日志；接口仍 MUST 返回上述统一 200 响应

**重置链接基础 URL：**

- 系统 MUST 优先使用服务端配置的 `APP_URL` 作为邮件链接的应用基础 URL，不得使用请求中的 `Host` 或 `X-Forwarded-Proto` 覆盖它
- 非生产环境未配置 `APP_URL` 时，系统 MAY 使用当前请求头拼接基础 URL 作为开发回退
- `NOJ_ENV=production` 且未配置 `APP_URL` 时，系统 MUST 忽略请求头中的 `Host` 与 `X-Forwarded-Proto`，不得发送任何含有请求头来源 URL 的邮件

**令牌生成：**

- 32 字节随机数 MUST 由 `crypto.getRandomValues()` 生成
- 明文令牌 MUST 用 base64url 编码（43 字符），包含在邮件链接中
- DB 存储 MUST 是 SHA-256 hex 哈希，**不存明文**

**令牌有效期：** 15 分钟（MUST，与 OWASP 2025+ 一致）

#### Scenario: 已注册邮箱请求重置

- **WHEN** 已注册用户 POST `/api/v1/auth/forgot-password` 携带 `{"email": "<其注册邮箱>"}`，且可信的应用基础 URL 可用
- **THEN** 系统生成 32 字节 base64url 令牌，计算 SHA-256 哈希
- **THEN** 系统在 `password_reset_tokens` 表插入新行（user_id FK CASCADE、token_hash UNIQUE、expires_at = now + 15min、used_at = NULL）
- **THEN** 系统调用 `sendPasswordResetEmail()`（mock 模式打印到 stdout）
- **THEN** 系统返 200 和统一消息

#### Scenario: 已配置 APP_URL 时抵御 Host Header 注入

- **WHEN** 已注册用户请求重置，服务端已配置 `APP_URL=https://oj.example.com`，请求携带 `Host: evil.example` 或伪造的 `X-Forwarded-Proto`
- **THEN** 邮件中的重置链接 MUST 以 `https://oj.example.com/reset-password` 开头，不得包含 `evil.example` 或伪造协议
- **THEN** 系统返 200 和统一消息

#### Scenario: 非生产环境缺少 APP_URL

- **WHEN** `NOJ_ENV` 不是 `production`、服务端未配置 `APP_URL`，且请求携带 `Host: localhost:3000`
- **THEN** 系统 MAY 使用请求头拼接 `http://localhost:3000` 作为重置链接基础 URL
- **THEN** 系统返 200 和统一消息

#### Scenario: 生产环境缺少 APP_URL

- **WHEN** `NOJ_ENV=production`、服务端未配置 `APP_URL`，请求携带攻击者控制的 `Host: evil.example`
- **THEN** 系统记录内部配置错误日志
- **THEN** 系统 MUST 不创建密码重置令牌，不发送邮件，不使用 `evil.example` 构造链接
- **THEN** 系统仍返 200 和与正常请求完全相同的统一消息

#### Scenario: 未注册邮箱请求重置

- **WHEN** 任意邮箱 POST `/api/v1/auth/forgot-password` 携带 `{"email": "<未注册邮箱>"}`
- **THEN** 系统 MUST 不创建 token 行
- **THEN** 系统 MUST 不发送邮件
- **THEN** 系统返 200 和**完全相同**的响应消息（防邮箱枚举）

#### Scenario: 缺少 email 字段

- **WHEN** 客户端 POST `/api/v1/auth/forgot-password` 不携带 email
- **THEN** 系统返 400 和错误消息 `"缺少字段 email"`
