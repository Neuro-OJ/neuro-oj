## Purpose

数据库 Schema 规范增量：`users` 表新增 `must_change_password` 布尔字段。

## ADDED Requirements

### Requirement: users.must_change_password 列

`users` 表 MUST 包含 `must_change_password BOOLEAN NOT NULL DEFAULT false` 列，
用于标记用户首次登录后是否必须修改密码。

约束：

- `NOT NULL` — 不允许空值
- `DEFAULT false` — 存量用户默认 `false`，向前兼容
- 仅在以下场景被置为 `true`：种子脚本的 `ensureBootstrapAdmin()` 创建临时管
  理员时
- 仅在以下场景被置为 `false`：种子脚本的普通用户注册时（默认）、`changePassword()`
  成功后

#### Scenario: 字段存在且默认 false

- **WHEN** 数据库执行 migration 0006 后查询 `users` 表结构
- **THEN** 表中存在 `must_change_password boolean NOT NULL DEFAULT false` 列

#### Scenario: 存量用户默认值

- **WHEN** migration 0006 在含已有用户的数据库上执行
- **THEN** 所有存量用户的 `must_change_password` 为 `false`，不影响其登录流
  程

#### Scenario: 引导管理员创建时置位

- **WHEN** `ensureBootstrapAdmin()` 插入临时管理员记录
- **THEN** 该用户记录的 `must_change_password=true`

#### Scenario: changePassword 成功后清字段

- **WHEN** 用户成功调用 `POST /api/v1/auth/change-password`
- **THEN** 该用户记录的 `must_change_password=false`