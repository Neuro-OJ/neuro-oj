## ADDED Requirements

### Requirement: 全站用户榜单查询

系统 SHALL 提供 `GET /api/v1/rankings` 公开接口，按解题数降序返回全站用户榜单。

榜单条目 SHALL 包含：`rank`（名次，1-based 整数）、`user_id`、`username`、`solved_count`（独立通过的题目数）、`total_submissions`（总提交数）、`acceptance_rate`（0–1 浮点数）。

榜单 SHALL 排除 root 系统用户（`users.id = '0'`），且 SHALL 仅展示至少通过一道题的用户。

排序键 SHALL 为：`(solved_count DESC, acceptance_rate DESC, total_submissions ASC, users.created_at ASC)`，确保相同指标下排名稳定。

#### Scenario: 正常查询全站榜单

- **WHEN** 系统中有用户 A（solved=5, total=10, rate=0.5）和用户 B（solved=3, total=5, rate=0.6）有通过记录，用户 C（solved=0）有提交但无通过记录
- **THEN** `GET /api/v1/rankings` 返回两个条目，A.rank=1, B.rank=2，C 不在结果中

#### Scenario: 排序稳定

- **WHEN** 两个用户 D（solved=3, rate=0.7, total=4）和 E（solved=3, rate=0.6, total=5）通过题数相同
- **THEN** D.rank < E.rank（因为 D.acceptance_rate 更高）

#### Scenario: 排除 root 用户

- **WHEN** root 系统用户（id='0'）存在且有提交记录
- **THEN** `GET /api/v1/rankings` 返回结果中不包含 root 用户的条目

#### Scenario: 全站无用户通过任何题

- **WHEN** 系统中所有用户都没有 `evaluation_results.status = 'Accepted'` 的记录
- **THEN** `GET /api/v1/rankings` 返回 `{ data: [], pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 } }`，HTTP 200

#### Scenario: 公开访问无需 token

- **WHEN** 任意访问者（含未登录用户）发送 `GET /api/v1/rankings`
- **THEN** 系统正常返回榜单，无需 Authorization 头

### Requirement: 榜单分页

系统 SHALL 支持 `page` 与 `limit` Query 参数。`page` 默认 1，`limit` 默认 50，最大 100。

响应 SHALL 包含 `pagination` 元数据：`page`、`per_page`（实际返回的每页数量）、`total`（总条目数）、`total_pages`（总页数）。

#### Scenario: 默认分页参数

- **WHEN** 调用 `GET /api/v1/rankings` 不带任何 query 参数
- **THEN** 系统按 `page=1, limit=50` 返回结果

#### Scenario: 超出 limit 上限

- **WHEN** 调用 `GET /api/v1/rankings?limit=200`
- **THEN** 系统按 `limit=100`（最大上限）返回结果，HTTP 200

#### Scenario: 非法 page 参数

- **WHEN** 调用 `GET /api/v1/rankings?page=0` 或 `page=-1`
- **THEN** 系统返回 HTTP 400，提示 page 必须 ≥ 1

#### Scenario: 越界 page

- **WHEN** 调用 `GET /api/v1/rankings?page=999` 超过实际页数
- **THEN** 系统返回 HTTP 200，`data: []`，pagination.total 反映真实总数

### Requirement: 当前用户排名查询

系统 SHALL 提供 `GET /api/v1/rankings/me` 接口（需登录），返回当前登录用户的榜单条目（含 `rank` 字段）。

若当前用户未通过任何题目（不在榜单），返回 `null`。

#### Scenario: 已登录用户有通过记录

- **WHEN** 已登录用户有 ≥1 道题通过
- **THEN** `GET /api/v1/rankings/me` 返回该用户的完整榜单条目 `{ rank, user_id, username, solved_count, total_submissions, acceptance_rate }`，HTTP 200

#### Scenario: 已登录用户无通过记录

- **WHEN** 已登录用户尚未通过任何题目（accepted=0）
- **THEN** `GET /api/v1/rankings/me` 返回 `null`（响应体为 `null`），HTTP 200

#### Scenario: 未登录访问被拒

- **WHEN** 未携带有效 JWT 的访问者发送 `GET /api/v1/rankings/me`
- **THEN** 系统返回 HTTP 401