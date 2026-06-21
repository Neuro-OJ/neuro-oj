## ADDED Requirements

### Requirement: 系统可返回分类树

系统 SHALL 提供
`GET /api/v1/categories`，返回所有分类并以树形结构组织（含子分类数组）。

#### Scenario: 获取分类树

- **WHEN** 用户请求 `GET /api/v1/categories`
- **THEN** 系统返回按层级嵌套的分类树数组

### Requirement: 管理员可创建分类

系统 SHALL 提供
`POST /api/v1/categories`，仅管理员可调用，用于创建分类；可选指定 `parent_id`
以建立父子关系。

#### Scenario: 管理员创建顶级分类

- **WHEN** 管理员发送 `POST /api/v1/categories` 并传入
  `{ "name": "数据结构", "slug": "data-structures" }`
- **THEN** 系统创建 level = 0 的分类并返回 201

#### Scenario: 管理员创建子分类

- **WHEN** 管理员发送 `POST /api/v1/categories` 并传入
  `{ "name": "树", "slug": "tree", "parent_id": "<parent-id>" }`
- **THEN** 系统创建 level = 父分类 level + 1 的分类

#### Scenario: 普通用户创建分类

- **WHEN** 普通用户调用 `POST /api/v1/categories`
- **THEN** 系统返回 HTTP 403

#### Scenario: 父分类不存在

- **WHEN** 管理员创建分类时指定了不存在的 `parent_id`
- **THEN** 系统返回 HTTP 400

#### Scenario: slug 冲突

- **WHEN** 管理员创建分类时使用已存在的 `slug`
- **THEN** 系统返回 HTTP 409

### Requirement: 管理员可更新分类

系统 SHALL 提供 `PUT /api/v1/categories/:id`，仅管理员可调用。

#### Scenario: 管理员成功更新分类

- **WHEN** 管理员发送 `PUT /api/v1/categories/:id` 并携带有效字段
- **THEN** 系统更新分类并返回更新后的分类详情

#### Scenario: 更新导致循环父子关系

- **WHEN** 管理员将某分类的 `parent_id` 设置为其自身子孙节点
- **THEN** 系统返回 HTTP 400

### Requirement: 管理员可删除分类

系统 SHALL 提供 `DELETE /api/v1/categories/:id`，仅管理员可调用。

#### Scenario: 管理员删除无子分类的分类

- **WHEN** 管理员删除没有子分类的分类
- **THEN** 系统删除分类并返回 204

#### Scenario: 管理员删除带子分类的分类

- **WHEN** 管理员删除带子分类的分类
- **THEN** 系统返回 HTTP 400，提示先删除或迁移子分类

### Requirement: 题目可与多个分类关联

系统 SHALL 支持在创建/更新题目时通过 `category_ids`
数组指定题目所属分类，并持久化到 `problems_categories` 关联表。

#### Scenario: 创建题目时关联分类

- **WHEN** 管理员创建题目时传入 `category_ids: ["<id1>", "<id2>"]`
- **THEN** 系统创建题目并建立与这些分类的关联

#### Scenario: 更新题目时替换分类

- **WHEN** 管理员更新题目时传入新的 `category_ids`
- **THEN** 系统删除旧关联并建立新关联

#### Scenario: 关联不存在的分类

- **WHEN** 管理员传入包含不存在分类 ID 的 `category_ids`
- **THEN** 系统返回 HTTP 400
