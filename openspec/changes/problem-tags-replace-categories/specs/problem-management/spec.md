## MODIFIED Requirements

### Requirement: 用户可删除题目

系统 SHALL 提供 `DELETE /api/v1/problems/:id`。U 型所有者可删除自己题目，P 型仅管理员可删除。

#### Scenario: 管理员成功删除题目
- **WHEN** 管理员调用 `DELETE /api/v1/problems/:id`
- **THEN** 系统删除题目及其标签关联并返回 204

#### Scenario: U 型所有者删除自己题目
- **WHEN** 普通用户删除自己所有的 U 型题目
- **THEN** 系统返回 204

#### Scenario: 普通用户删除 P 型被拒
- **WHEN** 普通用户删除 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: 删除不存在的题目
- **WHEN** 管理员删除 `DELETE /api/v1/problems/nonexistent`
- **THEN** 系统返回 HTTP 404

### Requirement: 题目列表支持多维度筛选与分页

系统 SHALL 在 `GET /api/v1/problems` 上支持 `difficulty`、`tag`、`keyword`、`type`、`number` 查询参数。

#### Scenario: 按难度筛选
- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy`
- **THEN** 系统仅返回难度为 easy 的题目

#### Scenario: 按标签筛选
- **WHEN** 用户请求 `GET /api/v1/problems?tag=<tag-id>`
- **THEN** 系统仅返回关联该标签的题目

#### Scenario: 按关键词搜索
- **WHEN** 用户请求 `GET /api/v1/problems?keyword=归一化`
- **THEN** 系统返回标题、描述或题号中包含该关键词的题目

#### Scenario: 按类型筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=U`
- **THEN** 系统仅返回 U 型题目

#### Scenario: 按题号筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=P&number=1001`
- **THEN** 系统仅返回 P 型中 number=1001 的题目

#### Scenario: 组合筛选加分页
- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy&keyword=归一化&page=1&limit=10`
- **THEN** 系统返回同时满足所有条件的分页结果

#### Scenario: 非法分页参数
- **WHEN** 用户请求 `GET /api/v1/problems?page=abc`
- **THEN** 系统返回 HTTP 400

#### Scenario: display_id 返回
- **WHEN** 用户请求题目列表或详情
- **THEN** 响应中包含 display_id（如 "P1001"）、owner_id、type、number 字段

## ADDED Requirements

### Requirement: 题目详情响应包含标签与算法标签可见性

题目详情响应 SHALL 以 `tags: {id, name, kind}[]` 取代 `categories` 字段，并附带 `has_hidden_algorithm_tags: boolean` 标志，按 `problem-tags` 规范的门控规则裁剪（算法标签仅 admin/题主/有 Accepted 提交的 viewer 可见）。

#### Scenario: 详情响应标签字段

- **WHEN** 用户请求 `GET /api/v1/problems/:id`
- **THEN** 响应包含 `tags` 数组（每项含 id/name/kind）与 `has_hidden_algorithm_tags` 布尔字段，不含 `categories` 字段
