## Purpose

定义 Neuro OJ 题目管理系统规范，包括题目 CRUD、多维度筛选与分页、难度约束。
管理员可管理题目，普通用户可查看和筛选。

## Requirements

### Requirement: 管理员可创建题目

系统 SHALL 提供 `POST /api/v1/problems`，仅管理员可调用，用于创建新题目。

#### Scenario: 管理员成功创建题目

- **WHEN** 管理员发送 `POST /api/v1/problems` 并携带有效题目字段
- **THEN** 系统创建题目记录并返回 201 与题目详情

#### Scenario: 缺少必填字段

- **WHEN** 管理员创建题目时缺少 `title`、`judge_image` 或 `judge_command`
- **THEN** 系统返回 HTTP 400，提示缺少必填字段

#### Scenario: 非法难度值

- **WHEN** 管理员创建题目时传入 `difficulty: "expert"`
- **THEN** 系统返回 HTTP 400，提示难度值仅允许 easy/medium/hard

#### Scenario: 普通用户创建题目

- **WHEN** 普通用户调用 `POST /api/v1/problems`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可更新题目

系统 SHALL 提供 `PUT /api/v1/problems/:id`，仅管理员可调用，用于全量更新题目信息。

#### Scenario: 管理员成功更新题目

- **WHEN** 管理员发送 `PUT /api/v1/problems/:id` 并携带完整有效字段
- **THEN** 系统更新题目并返回更新后的题目详情

#### Scenario: 更新不存在的题目

- **WHEN** 管理员更新 `PUT /api/v1/problems/nonexistent`
- **THEN** 系统返回 HTTP 404

#### Scenario: 普通用户更新题目

- **WHEN** 普通用户调用 `PUT /api/v1/problems/:id`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可删除题目

系统 SHALL 提供 `DELETE /api/v1/problems/:id`，仅管理员可调用。

#### Scenario: 管理员成功删除题目

- **WHEN** 管理员调用 `DELETE /api/v1/problems/:id`
- **THEN** 系统删除题目及其分类关联并返回 204

#### Scenario: 删除不存在的题目

- **WHEN** 管理员删除 `DELETE /api/v1/problems/nonexistent`
- **THEN** 系统返回 HTTP 404

### Requirement: 题目列表支持多维度筛选与分页

系统 SHALL 在 `GET /api/v1/problems` 上支持 `difficulty`、`category_id`、`keyword` 查询参数，并保留 `page` 与 `limit` 分页。

#### Scenario: 按难度筛选

- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy`
- **THEN** 系统仅返回难度为 easy 的题目

#### Scenario: 按分类筛选

- **WHEN** 用户请求 `GET /api/v1/problems?category_id=<category-id>`
- **THEN** 系统仅返回属于该分类的题目

#### Scenario: 按关键词搜索

- **WHEN** 用户请求 `GET /api/v1/problems?keyword=归一化`
- **THEN** 系统返回标题或描述中包含该关键词的题目

#### Scenario: 组合筛选加分页

- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy&keyword=归一化&page=1&limit=10`
- **THEN** 系统返回同时满足所有条件的分页结果

#### Scenario: 非法分页参数

- **WHEN** 用户请求 `GET /api/v1/problems?page=abc`
- **THEN** 系统返回 HTTP 400

### Requirement: 数据库强制限制难度取值

系统 SHALL 通过数据库 `CHECK` 约束确保 `problems.difficulty` 仅允许 `'easy'`、`'medium'`、`'hard'`。

#### Scenario: 非法难度写入数据库

- **WHEN** 任何 SQL 尝试写入 `difficulty = 'invalid'`
- **THEN** 数据库返回约束违反错误
