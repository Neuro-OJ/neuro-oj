## Purpose

定义 Neuro OJ 题目所有权机制规范，包括题目归属、类型驱动权限判断、
题号自增、双索引路由查找。题目分为 U（用户题库）和 P（主题库）两种类型。

## Requirements

### Requirement: 题目类型与题号

系统 SHALL 在 problems 表中使用 `type`（TEXT, 'U'/'P'）和 `number`（INTEGER）字段，
`display_id`（格式 `{type}{number}`，如 `P1001`）作为对外展示标识。

#### Scenario: U 型题目
- **WHEN** 创建一道 type='U' 的题目
- **THEN** 系统记录该题为 U 型（用户题），number 在 U 型中独立自增

#### Scenario: P 型题目
- **WHEN** 创建一道 type='P' 的题目
- **THEN** 系统记录该题为 P 型（专题/管理题），number 在 P 型中独立自增

#### Scenario: U 和 P 题号独立
- **WHEN** 分别创建 type='U' 和 type='P' 的题目，二者 number 均为 1
- **THEN** U1 和 P1 是两道不同的题目，互不冲突

### Requirement: 题目自动编号

系统 SHALL 为每个 type 独立自增 number，使用 `SELECT COALESCE(MAX(number), 0) + 1` 分配。

#### Scenario: U 型自动编号递增
- **WHEN** 用户连续创建三道 U 型题目且未指定 number
- **THEN** 三道题的 number 分别为 1、2、3

#### Scenario: 管理员指定题号
- **WHEN** 管理员创建 P 型题目时指定 number=2001
- **THEN** 使用指定值，校验 UNIQUE(type, number) 不冲突则写入

### Requirement: 双索引路由查找

系统 SHALL 在 `GET /api/v1/problems/:id` 中同时支持 UUID 和 display_id 两种索引格式。

#### Scenario: 按 UUID 查找
- **WHEN** 用户请求 `GET /api/v1/problems/550e8400-e29b-41d4-a716-446655440000`
- **THEN** 系统按 `problems.id` 查找并返回题目

#### Scenario: 按 display_id 查找
- **WHEN** 用户请求 `GET /api/v1/problems/P1001`
- **THEN** 系统解析 display_id 为 (type='P', number=1001)，按组合唯一索引查找

### Requirement: 基于 type + owner 的权限控制

系统 SHALL 在服务层实现基于题目类型和所有者的权限判断。

#### Scenario: 管理员可编辑任意题目
- **WHEN** admin 调用 `PUT /api/v1/problems/:id`
- **THEN** 无论 type 和 owner_id 为何值，均允许更新

#### Scenario: U 型所有者可编辑
- **WHEN** 普通用户编辑自己所有的 U 型题目
- **THEN** 系统允许更新

#### Scenario: U 型非所有者不可编辑
- **WHEN** 普通用户编辑他人所有的 U 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: 普通用户不可编辑 P 型
- **WHEN** 普通用户（含所有者）编辑 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: U 型所有者可删除
- **WHEN** 普通用户删除自己所有的 U 型题目
- **THEN** 系统允许删除

#### Scenario: P 型仅管理员可删除
- **WHEN** 普通用户删除 P 型题目
- **THEN** 系统返回 HTTP 403
