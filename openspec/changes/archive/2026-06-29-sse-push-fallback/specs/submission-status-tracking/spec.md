## MODIFIED Requirements

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
