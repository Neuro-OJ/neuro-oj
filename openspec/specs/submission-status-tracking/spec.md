## Purpose

定义单个提交的队列状态追踪规范，包括 `GET /api/v1/submissions/:id/status` 端点和提交结果页的过渡状态展示。

## Requirements

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
  "judge_started_at": "2024-01-15T10:30:00Z",
  "judge_finished_at": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 提交 ID |
| `status` | enum | 评测状态：pending / judging / finished / error |
| `queue_position` | int? | 在 pending 队列中的 1-based 位置；`null` 表示不在排队中（已在 judging 或已完成） |
| `queue_length` | int? | 当前 pending 队列总长度 |
| `judge_started_at` | string? | ISO 8601，开始评测时间，`null` 表示尚未开始 |
| `judge_finished_at` | string? | ISO 8601，完成时间，`null` 表示尚未完成 |

#### Scenario: 查询排队中提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<pending-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `pending`，`queue_position` 为 >= 1 的整数，`queue_length` > 0，`judge_started_at` 和 `judge_finished_at` 为 `null`

#### Scenario: 查询正在评测提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<judging-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `judging`，`queue_position` 为 `null`，`judge_started_at` 不为 `null`，`judge_finished_at` 为 `null`

#### Scenario: 查询已完成提交的状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<finished-uuid>/status`
- **THEN** 系统返回 200，`status` 为 `finished` 或 `error`，`queue_position` 为 `null`，`judge_started_at` 和 `judge_finished_at` 均不为 `null`

#### Scenario: 未认证用户查询提交状态

- **WHEN** 客户端未提供 Authorization 头 GET `/api/v1/submissions/<uuid>/status`
- **THEN** 系统返回 401

#### Scenario: 查询不存在的提交状态

- **WHEN** 已登录用户 GET `/api/v1/submissions/<non-existent-uuid>/status`
- **THEN** 系统返回 404

#### Scenario: 非提交者查询他人提交

- **WHEN** 已登录用户 A GET `/api/v1/submissions/<user-B-uuid>/status`
- **THEN** 系统返回 200，正常返回状态信息（不限提交者身份）

### Requirement: 提交结果页排队状态展示

提交结果页面 `pages/submissions/[id].vue` SHALL 根据 `status` 展示不同的过渡状态：

- `pending`：显示"排队中…"并展示 `queue_position / queue_length`，配等待动画
- `judging`：显示"正在评测…"，配运行中动画
- `finished` / `error`：自动显示评测结果页

页面 SHALL 优先通过 SSE（`GET /api/v1/submissions/:id/events`）接收状态更新通知。SSE 事件仅作触发信号，收到后通过 REST 调 `GET /api/v1/submissions/:id` 拉取全量数据。当 SSE 不可用时 SHALL 降级到每 1.5 秒轮询 `GET /api/v1/submissions/:id` 检查状态变更。当 `pollSubmission()` 检测到状态变为 finished 或 error 时，关闭 SSE 连接并展示结果。

#### Scenario: 排队中状态展示

- **WHEN** 用户访问 `/submissions/<pending-uuid>`，提交处于排队中
- **THEN** 页面显示"排队中…"和 `queue_position / queue_length`，配等待动画，通过 SSE 接收状态更新

#### Scenario: 评测中状态展示

- **WHEN** 用户访问 `/submissions/<judging-uuid>`，提交正在评测
- **THEN** 页面显示"正在评测…"，配运行中动画，通过 SSE 等待结果

#### Scenario: 排队→评测→完成状态流转（SSE）

- **WHEN** 提交从 pending 变为 judging，再变为 finished
- **THEN** UI 通过 SSE 实时从排队状态→评测状态→结果页过渡，状态变更后停止推送

#### Scenario: SSE 不可用时降级轮询

- **WHEN** SSE 连接失败或浏览器不支持 EventSource
- **THEN** 页面自动降级到每 1.5 秒轮询 `GET /api/v1/submissions/:id`，功能与现有行为一致

#### Scenario: 非提交者查看提交页面

- **WHEN** 已登录用户访问他人的 `/submissions/<other-uuid>` 提交页面
- **THEN** 正常显示排队/评测状态信息，但不显示源代码
