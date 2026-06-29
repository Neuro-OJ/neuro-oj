## MODIFIED Requirements

### Requirement: 全局队列页面

系统 SHALL 提供前端页面 `/queue`，展示全局评测队列状态，面向所有访客开放（无需登录）。

排序规则（与 API 相反，按时间倒序，越靠近上端越新）：
- 正在评测：按 `judge_started_at` 降序（最新开始的在上）
- 排队中：按 `submitted_at` 降序（最新提交的在上）
- 最近完成：按 `judge_finished_at` 降序（最新完成的在上）

每个卡片/行显示：提交 ID（可截断）、题目编号和标题、语言、提交者用户名、提交时间。
正在评测的项目额外显示开始评测时间和持续时间。
已完成的项目额外显示得分和完成时间。

页面 SHALL 优先通过 SSE（`GET /api/v1/queue/events` 管理员）接收队列变更通知，收到 `queue:changed` 事件时立即调用 `GET /api/v1/queue` 刷新全量数据。当 SSE 不可用时 SHALL 降级到每 2 秒轮询 `GET /api/v1/queue` 刷新状态。

#### Scenario: 访问队列页面

- **WHEN** 用户访问 `/queue`
- **THEN** 页面展示三区域分组列表，优先通过 SSE 接收更新通知

#### Scenario: 队列页面在未登录状态下可访问

- **WHEN** 未登录用户访问 `/queue`
- **THEN** 页面正常显示全局队列状态

#### Scenario: SSE 驱动刷新

- **WHEN** 页面通过 SSE 收到 `queue:changed` 事件
- **THEN** 页面立即调用 `GET /api/v1/queue` 刷新全量数据，无需等待轮询间隔

#### Scenario: SSE 不可用时降级轮询

- **WHEN** SSE 连接失败或浏览器不支持 EventSource
- **THEN** 页面自动降级到每 2 秒轮询 `GET /api/v1/queue`，功能与现有行为一致
