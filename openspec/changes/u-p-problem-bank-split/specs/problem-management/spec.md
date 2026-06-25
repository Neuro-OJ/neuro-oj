## Purpose

题目管理规范增量更新：权限模型从「仅管理员」改为基于 type + owner 的细粒度控制，
创建/更新/删除/列表均适配 U/P 双题库。

## MODIFIED Requirements

### Requirement: 管理员可创建题目

系统 SHALL 提供 `POST /api/v1/problems`，管理员可创建任意 type 的题目，
普通用户可创建 type='U' 的题目（自动成为所有者）。

#### Scenario: 管理员成功创建 P 型题目
- **WHEN** 管理员发送 `POST /api/v1/problems` 并携带 type='P' 及有效字段
- **THEN** 系统创建 P 型题目（admin 自动成为所有者）并返回 201

#### Scenario: 普通用户成功创建 U 型题目
- **WHEN** 普通用户发送 `POST /api/v1/problems` 并携带 type='U' 及有效字段
- **THEN** 系统创建 U 型题目，自动设 owner_id 为当前用户，自动分配 number，返回 201

#### Scenario: 普通用户尝试创建 P 型题目
- **WHEN** 普通用户调用 `POST /api/v1/problems` 并携带 type='P'
- **THEN** 系统返回 HTTP 403

#### Scenario: 创建题目时不传 type 默认 U
- **WHEN** 用户发送 `POST /api/v1/problems` 且未传 type 字段
- **THEN** 系统默认 type='U'

### Requirement: 管理员可更新题目

系统 SHALL 提供 `PUT /api/v1/problems/:id`，权限基于 type + owner 判断。

#### Scenario: 管理员成功更新题目
- **WHEN** 管理员发送 `PUT /api/v1/problems/:id` 并携带有效字段
- **THEN** 系统更新题目并返回更新后的题目详情

#### Scenario: U 型所有者更新自己题目
- **WHEN** 普通用户发送 `PUT /api/v1/problems/:id` 更新自己所有的 U 型题目
- **THEN** 系统允许更新

#### Scenario: U 型非所有者更新被拒
- **WHEN** 普通用户更新他人所有的 U 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: 普通用户更新 P 型被拒
- **WHEN** 普通用户更新 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: type 和 number 不可变更
- **WHEN** 任何用户更新题目时尝试修改 type 或 number
- **THEN** 系统忽略这两个字段的变更

### Requirement: 管理员可删除题目

系统 SHALL 提供 `DELETE /api/v1/problems/:id`。U 型所有者可删除自己题目，P 型仅管理员可删除。

#### Scenario: 管理员成功删除题目
- **WHEN** 管理员调用 `DELETE /api/v1/problems/:id`
- **THEN** 系统删除题目及其分类关联并返回 204

#### Scenario: U 型所有者删除自己题目
- **WHEN** 普通用户删除自己所有的 U 型题目
- **THEN** 系统返回 204

#### Scenario: 普通用户删除 P 型被拒
- **WHEN** 普通用户删除 P 型题目
- **THEN** 系统返回 HTTP 403

### Requirement: 题目列表支持多维度筛选与分页

系统 SHALL 在 `GET /api/v1/problems` 上支持 `difficulty`、`category_id`、`keyword`、`type`、`number` 查询参数。

#### Scenario: 按类型筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=U`
- **THEN** 系统仅返回 U 型题目

#### Scenario: 按题号筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=P&number=1001`
- **THEN** 系统仅返回 P 型中 number=1001 的题目

#### Scenario: display_id 返回
- **WHEN** 用户请求题目列表或详情
- **THEN** 响应中包含 display_id（如 "P1001"）、owner_id、type、number 字段
