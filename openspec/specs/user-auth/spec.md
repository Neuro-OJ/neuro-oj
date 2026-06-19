## Purpose

定义 Neuro OJ 用户认证系统的规范，包括用户注册、登录、JWT 认证及中间件。基于 Hono + jose + bcryptjs 实现，API 路径前缀为 `/api/v1/auth`。

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

- **WHEN** 客户端 POST `/api/v1/auth/register` 提供有效的 `username`、`email`、`password`
- **THEN** 系统创建用户记录，password_hash 为 bcrypt 哈希值，role 默认为 "user"，返回 201 和用户信息（不含 password_hash）

#### Scenario: 用户名重复

- **WHEN** 客户端尝试注册已存在的 `username`
- **THEN** 系统返回 409，错误消息 `"用户名已存在"`

#### Scenario: 邮箱重复

- **WHEN** 客户端尝试注册已存在的 `email`
- **THEN** 系统返回 409，错误消息 `"邮箱已被注册"`

#### Scenario: 用户名格式无效

- **WHEN** 客户端提供的 `username` 包含非法字符（如 `@`、空格）或长度不在 3-30 范围
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
- 成功：200，`{ "data": { "user": { ... }, "token": "<jwt>" } }`
- 失败：400（验证失败）或 401（凭证无效）

JWT 负载 MUST 包含 `sub`（用户 ID）和 `role`（用户角色），过期时间默认 24 小时。

为提高安全性，登录失败 MUST 返回统一消息 `"用户名或密码错误"`，不区分"用户不存在"和"密码错误"。

#### Scenario: 用用户名登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 提供有效的用户名和密码
- **THEN** 系统验证密码，返回 200 和包含用户信息及 JWT 的响应体

#### Scenario: 用邮箱登录成功

- **WHEN** 客户端 POST `/api/v1/auth/login` 的 `login` 字段为已注册的邮箱地址，密码正确
- **THEN** 系统按邮箱查找用户，验证密码，返回 200 和 JWT

#### Scenario: 密码错误

- **WHEN** 客户端提供正确的用户名但错误的密码
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`

#### Scenario: 用户不存在

- **WHEN** 客户端提供不存在的用户名或邮箱
- **THEN** 系统返回 401，错误消息 `"用户名或密码错误"`（与密码错误消息一致，防止用户枚举）

### Requirement: 获取当前用户信息

系统 SHALL 提供 `GET /api/v1/auth/me` 端点，返回当前认证用户的完整信息。

此端点 MUST 受 JWT 中间件保护。请求 MUST 包含有效的 `Authorization: Bearer <token>` 头。

响应：
- 成功：200，`{ "data": { "id", "username", "email", "role", "created_at", "updated_at" } }`
- 失败：401（未认证或令牌无效）

#### Scenario: 获取当前用户信息

- **WHEN** 客户端 GET `/api/v1/auth/me` 并提供有效的 Bearer token
- **THEN** 系统解析 token 中的用户 ID，从数据库查询用户信息，返回 200 和用户数据（不含 password_hash）

#### Scenario: 无认证令牌

- **WHEN** 客户端 GET `/api/v1/auth/me` 未提供 Authorization 头
- **THEN** 系统返回 401，错误消息 `"未提供认证令牌"`

#### Scenario: 令牌无效或已过期

- **WHEN** 客户端 GET `/api/v1/auth/me` 提供的 JWT 签名无效或已过期
- **THEN** 系统返回 401，错误消息 `"认证令牌无效或已过期"`

### Requirement: JWT 认证中间件

系统 SHALL 提供认证中间件，用于保护需要认证的路由。

中间件 MUST 执行以下流程：
1. 从请求头提取 `Authorization: Bearer <token>`
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
