## Purpose

定义 Neuro OJ 用户认证系统的规范，包括用户注册、登录、JWT 认证及中间件。基于
Hono + jose + bcryptjs 实现，API 路径前缀为 `/api/v1/auth`。

## Requirements

### Requirement: 用户注册

系统 SHALL 提供 `POST /api/v1/auth/register` 端点，允许新用户创建账号。

请求体：

- `username`（必填，string）：3-30 字符，仅允许字母、数字、下划线
- `email`（必填，string）：有效的邮箱地址
- `password`（必填，string）：至少 8 个字符

响应：

- 成功：201，`{ "data": { "id", "username", "email", "role", "created_at", "updated_at" } }`
- 失败：400（验证失败）或 409（用户名/邮箱重复）

密码 MUST 使用 bcrypt 哈希后存储，不可明文。

#### Scenario: 成功注册

- **WHEN** 客户端 POST `/api/v1/auth/register` 提供有效的
  `username`、`email`、`password`
- **THEN** 系统创建用户记录，password_hash 为 bcrypt 哈希值，role 默认为
  "user"，返回 201 和用户信息（不含 password_hash）

#### Scenario: 用户名重复

- **WHEN** 客户端尝试注册已存在的 `username`
- **THEN** 系统返回 409，错误消息 `"用户名已存在"`

#### Scenario: 邮箱重复

- **WHEN** 客户端尝试注册已存在的 `email`
- **THEN** 系统返回 409，错误消息 `"邮箱已被注册"`

#### Scenario: 用户名格式无效

- **WHEN** 客户端提供的 `username` 包含非法字符（如 `@`、空格）或长度不在 3-30
  范围
- **THEN** 系统返回 400，错误消息 `"用户名仅允许字母、数字和下划线，长度 3-30"`

#### Scenario: 密码过短

- **WHEN** 客户端提供的 `password` 少于 8 个字符
- **THEN** 系统返回 400，错误消息 `"密码长度不能少于 8 位"`

#### Scenario: 缺少必填字段

- **WHEN** 客户端请求缺少 `username`、`email` 或 `password` 中任一字段
- **THEN** 系统返回 400，错误消息指明缺少的字段

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

#### Scenario: 用用户名登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 提供有效的用户名和密码
- **THEN** 系统验证密码，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 用用户名登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 提供有效的用户名和密码
- **THEN** 代理将响应中的 `data.token` 提取为 HTTP-only Cookie `noj:token`，设置 readable cookie `noj:session`，移除响应体中的 `token` 字段，返回 200 和用户信息

#### Scenario: 用邮箱登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 的 `login`
  字段为已注册的邮箱地址，密码正确
- **THEN** 系统按邮箱查找用户，验证密码，返回 200 和 JWT

#### Scenario: 用邮箱登录成功（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确
- **THEN** 代理设置认证 cookie，返回用户信息（不含 token）

#### Scenario: 密码错误

- **WHEN** 客户端提供正确的用户名但错误的密码
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`，不设置任何 cookie

#### Scenario: 用户不存在

- **WHEN** 客户端提供不存在的用户名或邮箱
- **THEN** 系统返回 401，错误消息
  `"用户名或密码错误"`（与密码错误消息一致，防止用户枚举），不设置任何 cookie

### Requirement: 获取当前用户信息

系统 SHALL 提供 `GET /api/v1/auth/me` 端点，返回当前认证用户的完整信息。

此端点 MUST 受 JWT 中间件保护。请求 MUST 包含有效的 `Authorization: Bearer <token>` 头
（从 noj-core 直接调用时）。通过 Nitro 代理调用时，token 由代理从 `noj:token` cookie 自动注入。

响应：

- 成功：200，`{ "data": { "id", "username", "email", "role", "created_at", "updated_at" } }`
- 失败：401（未认证或令牌无效）

#### Scenario: 获取当前用户信息

- **WHEN** 客户端 GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** 系统解析 token 中的用户 ID，从数据库查询用户信息，返回 200
  和用户数据（不含 password_hash）

#### Scenario: 获取当前用户信息（通过 Nitro 代理）
- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求携带有效的 `noj:token` cookie
- **THEN** 代理自动注入 `Authorization: Bearer <token>` 头转发到 noj-core，noj-core 验证通过，返回 200 和用户数据；代理透传响应给客户端

#### Scenario: 获取当前用户信息（直接调用 noj-core）
- **WHEN** API 客户端直接调用 noj-core GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** noj-core 返回 200 和用户数据（行为不变）

#### Scenario: 无认证令牌

- **WHEN** 客户端 GET `/api/v1/auth/me` 未提供 Authorization 头
- **THEN** 系统返回 401，错误消息 `"未提供认证令牌"`

#### Scenario: 无 token cookie
- **WHEN** 客户端通过 Nitro 代理 GET `/api/v1/auth/me`，请求无 `noj:token` cookie
- **THEN** 代理转发请求时不添加 Authorization 头，noj-core 返回 401，代理透传 401 给客户端

#### Scenario: 令牌无效或已过期

- **WHEN** 客户端 GET `/api/v1/auth/me` 提供的 JWT 签名无效或已过期
- **THEN** 系统返回 401，错误消息 `"认证令牌无效或已过期"`

### Requirement: JWT 认证中间件

系统 SHALL 提供认证中间件，用于保护需要认证的路由。

中间件 MUST 执行以下流程：

1. 从请求头提取 `Authorization: Bearer <token>`（Nitro 代理已从 cookie 注入，或客户端直接提供）
2. 使用 `JWT_SECRET` 验证令牌签名和有效期
3. 验证成功后，将 `userId` 和 `userRole` 写入请求上下文
4. 验证失败时，返回 401 和适当的错误消息

默认 JWT 过期时间 SHALL 为 24 小时，可通过 `JWT_EXPIRES_IN` 环境变量配置。

#### Scenario: 有效令牌通过中间件

- **WHEN** 请求携带有效的 Bearer token，token 未过期且签名正确
- **THEN** 中间件将 `userId` 和 `userRole` 写入上下文，调用下一个处理程序

#### Scenario: 缺少 Authorization 头

- **WHEN** 请求未包含 Authorization 头
- **THEN** 中间件返回 401，错误消息 `"未提供认证令牌"`

#### Scenario: 过期令牌

- **WHEN** 请求携带的 JWT 已超过有效期
- **THEN** 中间件返回 401，错误消息 `"认证令牌无效或已过期"`

### Requirement: 密码重置请求

系统 SHALL 提供 `POST /api/v1/auth/forgot-password` 端点，接受 `email` 字段（必填 string），用于发起密码重置流程。

**防枚举行为：**

- 不管邮箱是否已注册，接口 MUST 统一返 200 + 同一响应消息：`{ "ok": true, "message": "如果该邮箱已注册，您将收到一封密码重置邮件" }`
- 邮箱存在时 MUST 实际生成令牌并发送邮件（mock 模式：控制台日志）
- 邮箱不存在或格式非法时 MUST 不发送邮件，但响应一致

**令牌生成：**

- 32 字节随机数 MUST 由 `crypto.getRandomValues()` 生成
- 明文令牌 MUST 用 base64url 编码（43 字符），包含在邮件链接中
- DB 存储 MUST 是 SHA-256 hex 哈希，**不存明文**

**令牌有效期：** 15 分钟（MUST，与 OWASP 2025+ 一致）

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

**令牌验证（原子消耗）：**

- 系统 MUST 用 SHA-256 哈希提交的 token
- 系统 MUST 在单 SQL 中完成消耗：`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`
- affected rows = 0 → 令牌无效/过期/已用，系统返 400 `"重置令牌无效或已过期"`
- affected rows = 1 → 拿到 user_id，继续执行密码更新

**密码更新：**

- 密码 MUST 通过 `validatePasswordStrength()` 校验（≥12 字符 + 大小写字母 + 数字 + 不得与用户名/邮箱相同）
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
