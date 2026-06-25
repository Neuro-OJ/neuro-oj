## Purpose

定义 Neuro OJ 提交历史查询 API
规范，支持用户查询自己的提交记录列表，支持分页和多条件筛选。管理员可查看所有用户的提交。API
路径前缀为 `/api/v1/submissions`，管理端为 `/api/v1/admin/submissions`。

## Requirements

### Requirement: 用户查询提交列表

系统 SHALL 提供 `GET /api/v1/submissions`
端点，返回当前认证用户的提交列表，支持分页和多条件筛选。

此端点 MUST 受 JWT 中间件保护。列表默认按 `created_at`
降序排列（最新提交在前）。

请求支持以下查询参数（均为可选）：

- `problem_id`（string）：按题目 ID 精确筛选（向后兼容）
- `problem_search`（string）：按题目 ID 精确匹配 OR 题目名称 ILIKE 模糊搜索。若输入值能精确匹配某个 `problem_id`，优先按 ID 筛选；否则按 `problems.title` ILIKE 搜索
- `submission_id`（string）：按提交 ID 前缀匹配（ILIKE `id || '%'`），输入前几位即可定位
- `language`（string）：按编程语言筛选
- `status`（string）：按提交状态筛选（pending / judging / finished / error）
- `from`（string）：起始日期（ISO 8601 日期，含当日）
- `to`（string）：截止日期（ISO 8601 日期，含当日）
- `page`（integer）：页码，默认 1，最小 1
- `per_page`（integer）：每页条数，默认 20，最小 1，最大 100

每条记录 SHALL 包含：

- 提交基本信息：`id`、`problem_id`、`language`、`file_name`、`status`、`created_at`
- 题目摘要：`problem.title`、`problem.id`
- 评测摘要：`result` 对象（含 `status`、`score`），无评测结果时为 `null`
- **不包含** `code` 字段（源代码仅在详情接口返回）

响应格式：

```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 42,
    "total_pages": 3
  }
}
```

#### Scenario: 按题目名称模糊搜索

- **WHEN** 用户 GET `/api/v1/submissions?problem_search=T0-LMCC`
- **THEN** 系统返回题目名称包含 "T0-LMCC" 的提交记录

#### Scenario: 按提交 ID 前缀搜索

- **WHEN** 用户 GET `/api/v1/submissions?submission_id=abc123`
- **THEN** 系统仅返回提交 ID 以 "abc123" 开头的记录

#### Scenario: 无筛选条件查询第一页

- **WHEN** 用户 GET `/api/v1/submissions` 不传任何查询参数，该用户有 15 条提交
- **THEN** 系统返回 200，`data` 包含 15 条记录，按 created_at
  降序，`pagination.total` 为 15，`pagination.total_pages` 为 1，每条包含
  problem 摘要和 result（如有）

#### Scenario: 按 problem_id 筛选

- **WHEN** 用户 GET `/api/v1/submissions?problem_id=1001`
- **THEN** 系统仅返回 problem_id 为 1001 的提交记录

#### Scenario: 按 status 筛选

- **WHEN** 用户 GET `/api/v1/submissions?status=finished`
- **THEN** 系统仅返回 status 为 finished 的提交记录

#### Scenario: 按日期范围筛选

- **WHEN** 用户 GET `/api/v1/submissions?from=2026-01-01&to=2026-06-20`
- **THEN** 系统仅返回 created_at 在 2026-01-01T00:00:00 至 2026-06-20T23:59:59
  范围内的提交

#### Scenario: 多条件组合筛选

- **WHEN** 用户 GET
  `/api/v1/submissions?problem_id=1001&language=python3&status=finished`
- **THEN** 系统返回同时满足三个筛选条件的提交记录

#### Scenario: 分页超出范围

- **WHEN** 用户 GET `/api/v1/submissions?page=999`，但总记录不足该页
- **THEN** 系统返回 200，`data` 为空数组，`pagination.total` 返回实际总数

#### Scenario: 未认证访问

- **WHEN** 客户端未提供 Authorization 头访问 `/api/v1/submissions`
- **THEN** 系统返回 401，错误消息 `"未提供认证令牌"`

#### Scenario: per_page 超过上限

- **WHEN** 用户 GET `/api/v1/submissions?per_page=200`
- **THEN** 系统将 per_page 限制为 100（最大值），按 100 返回

#### Scenario: 非法 page 值

- **WHEN** 用户 GET `/api/v1/submissions?page=0` 或 `page=-1`
- **THEN** 系统将 page 修正为 1

### Requirement: 管理员查询所有用户提交

系统 SHALL 提供 `GET /api/v1/admin/submissions`
端点，允许管理员查看所有用户的提交记录。

此端点 MUST 依次通过 `authMiddleware` 和 `adminMiddleware` 保护。路由 MUST
挂载在 `/api/v1/admin/` 路径前缀下。

支持与用户列表接口相同的筛选和分页参数，额外支持：

- `user_id`（string）：按用户 ID 精确筛选（向后兼容）
- `user_search`（string）：按 `users.username` ILIKE 模糊搜索 OR `submissions.user_id` 前缀匹配。若输入值看起来像 UUID（匹配 UUID 格式），优先按 user_id 搜索；否则按 username ILIKE 搜索。一个输入框同时支持两种输入。

管理员列表记录 SHALL 额外包含 `user_id` 字段，以便区分提交所属用户。

#### Scenario: 管理员按用户名搜索

- **WHEN** 管理员 GET `/api/v1/admin/submissions?user_search=john`
- **THEN** 系统返回用户名包含 "john" 的用户的提交记录

#### Scenario: 管理员按用户 ID 搜索

- **WHEN** 管理员 GET `/api/v1/admin/submissions?user_search=<user-uuid-prefix>`
- **THEN** 系统返回 user_id 以该前缀开头的提交记录

#### Scenario: 管理员查看所有提交

- **WHEN** 管理员 GET `/api/v1/admin/submissions` 不传 user_id
- **THEN** 系统返回所有用户的提交列表，每条记录包含 `user_id`

#### Scenario: 管理员按用户筛选（兼容旧参数）

- **WHEN** 管理员 GET `/api/v1/admin/submissions?user_id=<user-uuid>`
- **THEN** 系统仅返回该用户的提交记录

#### Scenario: 普通用户访问管理端点

- **WHEN** 已登录的普通用户（role=user）访问 `/api/v1/admin/submissions`
- **THEN** 系统返回 403，错误消息 `"需要管理员权限"`

#### Scenario: 未登录用户访问管理端点

- **WHEN** 未认证用户访问 `/api/v1/admin/submissions`
- **THEN** 系统返回 401，错误消息 `"未提供认证令牌"`

### Requirement: 用户查询提交详情 — 响应字段增强

`GET /api/v1/submissions/:id` 响应 SHALL 在现有字段基础上增加评测状态相关字段，减少前端轮询所需 API 调用次数。

新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | enum | 评测状态：pending / judging / finished / error |
| `queue_position` | int? | 在 pending 队列中的 1-based 位置；`null` 表示不在排队中 |
| `queue_length` | int? | 当前 pending 队列总长度 |
| `judge_started_at` | string? | ISO 8601，开始评测时间 |
| `judge_finished_at` | string? | ISO 8601，完成时间 |

`GET /api/v1/submissions` 列表接口的响应保持不变（不增加这些字段以避免列表响应体积膨胀）。

**注意 - 访问控制：** 新增的 queue 字段仍受现有所有者限制（仅提交者可查看详情）。非提交者需使用 `GET /api/v1/submissions/:id/status` 获取排队信息。

**Migration:** 调用方无需变更，新增字段为可选项。旧客户端忽略不认识的新字段即可。

#### Scenario: 查询详情包含状态字段

- **WHEN** 已登录用户 GET `/api/v1/submissions/<uuid>`（提交处于 pending 状态）
- **THEN** 响应包含 `status: "pending"`、`queue_position`（数值或 null）、`queue_length`（数值或 null）、`judge_started_at`（null）、`judge_finished_at`（null）

#### Scenario: 已完成提交的状态字段

- **WHEN** 已登录用户 GET `/api/v1/submissions/<uuid>`（提交已完成）
- **THEN** 响应包含 `status: "finished"` 或 `"error"`，`queue_position` 为 `null`，`judge_started_at` 和 `judge_finished_at` 为相应时间戳

#### Scenario: 列表接口不包含状态增强字段（向后兼容）

- **WHEN** 已登录用户 GET `/api/v1/submissions` 获取提交列表
- **THEN** 列表响应中不包含 `queue_position`、`queue_length`、`judge_started_at`、`judge_finished_at` 等新字段（仅详情接口新增）
