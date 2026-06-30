## Purpose

用户认证规范增量：JWT 负载携带 `must_change_password` claim、新增
`POST /api/v1/auth/change-password` 端点、`getUserProfile()` 返回该字段。

## MODIFIED Requirements

### Requirement: 用户登录

`POST /api/v1/auth/login` 成功后签发的 JWT MUST 包含 `must_change_password`
claim（与 DB 列名一致），响应体的 `user` 对象 MUST 包含 `must_change_password`
布尔字段。

#### Scenario: 登录响应包含 must_change_password

- **WHEN** 用户成功登录（任意账号）
- **THEN** 响应 `data.user.must_change_password` 与 DB 列值一致；JWT
  `must_change_password` claim 与之一致

#### Scenario: 引导管理员首次登录

- **WHEN** `must_change_password=true` 的引导管理员登录
- **THEN** 响应 `data.user.must_change_password=true`，JWT claim 同值；前端
  据此跳转到 `/change-password`

### Requirement: 获取当前用户信息

`GET /api/v1/auth/me` 响应 MUST 包含 `must_change_password` 字段，便于前端
路由守卫判断。

#### Scenario: me 响应包含强制改密字段

- **WHEN** 已登录用户 GET `/api/v1/auth/me`
- **THEN** 响应 `data.must_change_password` 与 DB 列值一致

## ADDED Requirements

### Requirement: 修改密码端点

系统 SHALL 提供 `POST /api/v1/auth/change-password`，要求登录态。

请求体：

- `old_password`（必填，string）：用户当前密码（root 系统用户 id='0' 不可登
  录，理论上不应调用此端点）
- `new_password`（必填，string）：新密码，复用注册时强度规则（≥12 位、含大小
  写字母+数字、不能与 username/email 前缀相同）

响应：

- 成功：200，`{ "data": { ...user, "must_change_password": false } }`
- 失败：400（缺少字段或新密码强度不足）或 401（原密码错误）

成功后 MUST 更新 `password_hash` 并将 `must_change_password` 设为 `false`。

此端点 MUST 受 issue #73 登录速率限制（IP 维度）保护。

#### Scenario: 引导管理员首次改密成功

- **WHEN** `must_change_password=true` 的用户 POST
  `/api/v1/auth/change-password` 携带正确 `old_password` 和符合强度规则的
  `new_password`
- **THEN** 系统更新密码哈希与 `must_change_password=false`，返回 200 与更新
  后的用户信息

#### Scenario: 原密码错误

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带错误的 `old_password`
- **THEN** 系统返回 401，错误消息 `"原密码错误"`，不修改数据库

#### Scenario: 新密码强度不足

- **WHEN** 用户 POST `/api/v1/auth/change-password` 携带 `new_password="123"`
- **THEN** 系统返回 400，错误消息指明密码不符合强度规则

#### Scenario: 缺少原密码

- **WHEN** 用户 POST `/api/v1/auth/change-password` 但请求体缺少
  `old_password` 字段
- **THEN** 系统返回 400，错误消息 `"缺少原密码"`

#### Scenario: 速率限制保护

- **WHEN** 同一 IP 在 rate-limit 窗口内高频调用 `/api/v1/auth/change-password`
- **THEN** 系统返回 429（issue #73 行为）

### Requirement: JWT 负载扩展

JWT 负载 MUST 包含 `must_change_password: boolean` claim，签发与验证时透传该
字段。

#### Scenario: 签发携带强制改密 claim

- **WHEN** `loginUser()` 为 `must_change_password=true` 的用户签发 JWT
- **THEN** JWT payload 包含 `"must_change_password": true`

#### Scenario: 验证透传 claim

- **WHEN** `verifyToken()` 解码 JWT
- **THEN** 返回的 `TokenPayload` 包含 `must_change_password` 字段，值与签发
  时一致

#### Scenario: 中间件读取 claim

- **WHEN** `authMiddleware` 验证 JWT
- **THEN** 中间件将 `payload.must_change_password` 写入
  `c.set("mustChangePassword", ...)`，供下游使用