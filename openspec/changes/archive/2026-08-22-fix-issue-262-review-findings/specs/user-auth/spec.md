## MODIFIED Requirements

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

数据库的唯一约束是用户名和邮箱唯一性的最终保证。无论重复发生在预检查阶段还是并发插入阶段，系统 MUST 返回 409，而不是将唯一约束异常作为 500 返回。

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

#### Scenario: 并发注册同一用户名

- **WHEN** 多个注册请求同时使用同一个尚不存在的 `username`
- **THEN** 至多一个请求创建用户，其余请求返回 409，错误消息 `"用户名已存在"`

#### Scenario: 并发注册同一邮箱

- **WHEN** 多个注册请求同时使用同一个尚不存在的 `email`
- **THEN** 至多一个请求创建用户，其余请求返回 409，错误消息 `"邮箱已被注册"`

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
