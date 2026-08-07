## MODIFIED Requirements

### Requirement: 题目类型与题号

系统 SHALL 在 problems 表中使用 `type`（TEXT, 'U'/'P'/'O'）和 `number`（INTEGER）字段，
`display_id`（格式 `{type}{number}`，如 `P1001`、`O1001`）作为对外展示标识。

#### Scenario: U 型题目
- **WHEN** 创建一道 type='U' 的题目
- **THEN** 系统记录该题为 U 型（用户题），number 在 U 型中独立自增

#### Scenario: P 型题目
- **WHEN** 创建一道 type='P' 的题目
- **THEN** 系统记录该题为 P 型（专题/管理题），number 在 P 型中独立自增

#### Scenario: O 型套卷
- **WHEN** 创建一道 type='O' 的题目
- **THEN** 系统记录该题为 O 型（客观题套卷），number 在 O 型中独立自增

#### Scenario: U / P / O 题号独立
- **WHEN** 分别创建 type='U'、type='P'、type='O' 的题目，三者 number 均为 1
- **THEN** U1、P1、O1 是三道不同的题目，互不冲突

### Requirement: 双索引路由查找

系统 SHALL 在 `GET /api/v1/problems/:id` 中同时支持 UUID 和 display_id 两种索引格式。

#### Scenario: 按 UUID 查找
- **WHEN** 用户请求 `GET /api/v1/problems/550e8400-e29b-41d4-a716-446655440000`
- **THEN** 系统按 `problems.id` 查找并返回题目

#### Scenario: 按 display_id 查找
- **WHEN** 用户请求 `GET /api/v1/problems/P1001`
- **THEN** 系统解析 display_id 为 (type='P', number=1001)，按组合唯一索引查找

#### Scenario: 按 O 型 display_id 查找
- **WHEN** 用户请求 `GET /api/v1/problems/O1001`
- **THEN** 系统解析 display_id 为 (type='O', number=1001)，按组合唯一索引查找并返回套卷

### Requirement: 基于 type + owner 的权限控制

系统 SHALL 在服务层实现基于题目类型和所有者的权限判断。O 型套卷 SHALL 遵循 U 型规则（owner/admin 可 CRUD，P 型仅 admin 的规则不适用于 O 型）。

#### Scenario: 管理员可编辑任意题目
- **WHEN** admin 调用 `PUT /api/v1/problems/:id`
- **THEN** 无论 type 和 owner_id 为何值，均允许更新

#### Scenario: U 型所有者可编辑
- **WHEN** 普通用户编辑自己所有的 U 型题目
- **THEN** 系统允许更新

#### Scenario: O 型所有者可编辑
- **WHEN** 普通用户编辑自己所有的 O 型套卷
- **THEN** 系统允许更新

#### Scenario: U 型非所有者不可编辑
- **WHEN** 普通用户编辑他人所有的 U 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: O 型非所有者不可编辑
- **WHEN** 普通用户编辑他人所有的 O 型套卷
- **THEN** 系统返回 HTTP 403

#### Scenario: 普通用户不可编辑 P 型
- **WHEN** 普通用户（含所有者）编辑 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: U 型所有者可删除
- **WHEN** 普通用户删除自己所有的 U 型题目
- **THEN** 系统允许删除

#### Scenario: O 型所有者可删除
- **WHEN** 普通用户删除自己所有的 O 型套卷
- **THEN** 系统允许删除

#### Scenario: P 型仅管理员可删除
- **WHEN** 普通用户删除 P 型题目
- **THEN** 系统返回 HTTP 403
