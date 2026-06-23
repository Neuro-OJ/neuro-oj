## MODIFIED Requirements

### Requirement: 用户查询提交列表 — 响应字段增强

系统 SHALL 在现有 `GET /api/v1/submissions/:id` 响应中增加评测状态相关字段。

增强后的 `GET /api/v1/submissions/:id` 响应 SHALL 包含以下新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | enum | 评测状态：pending / judging / finished / error |
| `queue_position` | int? | 在 pending 队列中的 1-based 位置；`null` 表示不在排队中 |
| `queue_length` | int? | 当前 pending 队列总长度 |
| `judge_started_at` | string? | ISO 8601，开始评测时间 |
| `judge_finished_at` | string? | ISO 8601，完成时间 |

现有 `GET /api/v1/submissions` 列表接口的响应保持不变（不增加这些字段以避免列表响应的体积膨胀）。

**注意 - 访问控制：** 现有 `GET /api/v1/submissions/:id` 仍保持所有者限制（仅提交者可查看详情页面含源代码），新增的 queue 字段随此接口仅对提交者可用。非提交者需使用 `GET /api/v1/submissions/:id/status` 获取排队信息。

**Reason:** 减少前端轮询所需的 API 调用次数——在单个提交详情接口中直接包含状态信息，前端只需轮询这一个端点即可获得完整状态。

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
