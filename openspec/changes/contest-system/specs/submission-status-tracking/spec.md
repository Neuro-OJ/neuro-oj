## MODIFIED Requirements

### Requirement: 单个提交状态 API

系统 SHALL 提供 `GET /api/v1/submissions/:id/status` 端点，返回指定提交的当前状态和排队信息。

此端点 MUST 受 JWT 中间件保护，但不对提交者身份做限制——任意已登录用户可查询任意提交。

响应格式：

```json
{
  "id": "uuid",
  "status": "pending" | "judging" | "finished" | "error",
  "queue_position": 3,
  "queue_length": 12,
  "contest_id": "uuid-or-null",
  "judge_started_at": "2024-01-15T10:30:00Z",
  "judge_finished_at": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 提交 ID |
| `status` | enum | 评测状态：pending / judging / finished / error |
| `queue_position` | int? | 在 pending 队列中的 1-based 位置；`null` 表示不在排队中 |
| `queue_length` | int? | 当前 pending 队列总长度 |
| `contest_id` | string? | 关联的竞赛 ID（新增），NULL = 非竞赛提交 |
| `judge_started_at` | string? | ISO 8601，开始评测时间 |
| `judge_finished_at` | string? | ISO 8601，完成时间 |

#### Scenario: 查询排队中提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<pending-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `pending`，`queue_position` 为 >= 1 的整数，`queue_length` > 0，`judge_started_at` 和 `judge_finished_at` 为 `null`

#### Scenario: 查询正在评测提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<judging-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `judging`，`queue_position` 为 `null`，`judge_started_at` 不为 `null`，`judge_finished_at` 为 `null`

#### Scenario: 查询已完成提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<finished-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `finished` 或 `error`，`queue_position` 为 `null`，`judge_started_at` 和 `judge_finished_at` 均不为 `null`

#### Scenario: 竞赛提交的状态查询

- **WHEN** 已登录用户 GET `/api/v1/submissions/<contest-submission-uuid>/status`，该提交关联了 `contest_id`
- **THEN** 系统返回 200，`contest_id` 字段非 null，指向对应的竞赛

#### Scenario: 未认证用户查询提交状态

- **WHEN** 客户端未提供 Authorization 头 GET `/api/v1/submissions/<uuid>/status`
- **THEN** 系统返回 401

#### Scenario: 查询不存在的提交状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<non-existent-uuid>/status`
- **THEN** 系统返回 404

#### Scenario: 非提交者查询他人提交

- **WHEN** 已登录用户 A GET `/api/v1/submissions/<user-B-uuid>/status`
- **THEN** 系统返回 200，正常返回状态信息（不限提交者身份）

## ADDED Requirements

### Requirement: 竞赛提交代码可见性

竞赛提交的代码 SHALL 在竞赛期间仅提交者本人和管理员可见。竞赛结束后，竞赛提交 SHALL 按普通提交的可见性规则处理。

#### Scenario: 竞赛期间非提交者无法查看代码

- **WHEN** 竞赛 running 期间，参赛者 A 尝试 GET `/api/v1/submissions/<contest-submission-of-user-B>`
- **THEN** 系统返回 200 但不包含 `code` 字段和 `result.output`/`result.details`

#### Scenario: 竞赛结束后提交代码公开

- **WHEN** 竞赛已 ended，任意用户 GET `/api/v1/submissions/<contest-submission>`
- **THEN** 系统按普通提交的可见性规则处理（非所有者不返回 code 和 result 详情）
