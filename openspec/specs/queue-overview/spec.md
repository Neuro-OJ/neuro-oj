## Purpose

定义 Neuro OJ 评测队列全局概览功能的规范，包括公共 API `GET /api/v1/queue` 和前端 `/queue` 页面，面向所有访客（guest + user）开放。

## Requirements

### Requirement: 公共队列概览 API

系统 SHALL 提供 `GET /api/v1/queue` 端点，返回当前评测队列的完整状态，无需认证（面向 guest 和 user 开放）。

端点 MUST 挂载在公共路由上，不经过 JWT 中间件。

响应格式：

```json
{
  "pending": [
    {
      "id": "uuid-1",
      "problem_id": "1001",
      "problem_title": "两数之和",
      "language": "python3",
      "submitted_at": "2024-01-15T10:30:00Z",
      "submitted_by": "user1"
    }
  ],
  "judging": [
    {
      "id": "uuid-2",
      "problem_id": "1002",
      "problem_title": "反转链表",
      "language": "rust",
      "submitted_at": "2024-01-15T10:29:00Z",
      "submitted_by": "user2",
      "judge_started_at": "2024-01-15T10:29:30Z"
    }
  ],
  "recently_completed": [
    {
      "id": "uuid-3",
      "problem_id": "1001",
      "problem_title": "两数之和",
      "language": "cpp",
      "submitted_at": "2024-01-15T10:25:00Z",
      "submitted_by": "user3",
      "judge_started_at": "2024-01-15T10:25:10Z",
      "judge_finished_at": "2024-01-15T10:25:15Z",
      "status": "finished",
      "score": 100
    }
  ],
  "stats": {
    "pending_count": 8,
    "judging_count": 4,
    "completed_today": 120
  }
}
```

#### Scenario: 未认证用户获取队列概览

- **WHEN** 客户端（未提供 Authorization 头）GET `/api/v1/queue`
- **THEN** 系统返回 200，包含 `pending`、`judging`、`recently_completed` 三个数组和 `stats` 对象

#### Scenario: 队列为空

- **WHEN** 系统无任何待处理的评测任务
- **THEN** `GET /api/v1/queue` 返回 `pending` 和 `judging` 为空数组，`recently_completed` 可能为空数组或包含历史记录，`stats.pending_count` 和 `stats.judging_count` 为 0

#### Scenario: pending 列表按提交时间升序排列

- **WHEN** `GET /api/v1/queue` 的 `pending` 数组包含多条记录
- **THEN** 按 `submitted_at` 升序排列（先提交的先评测，排在最前）

#### Scenario: judging 列表按开始时间升序排列

- **WHEN** `GET /api/v1/queue` 的 `judging` 数组包含多条记录
- **THEN** 按 `judge_started_at` 升序排列

#### Scenario: recently_completed 按完成时间降序排列

- **WHEN** `GET /api/v1/queue` 的 `recently_completed` 数组包含多条记录
- **THEN** 按 `judge_finished_at` 降序排列（最新完成的在前）

#### Scenario: recently_completed 最多返回 10 条

- **WHEN** 有超过 10 条已完成的评测
- **THEN** 系统只返回最近完成的 10 条记录

#### Scenario: stats 统计字段正确

- **WHEN** `GET /api/v1/queue`
- **THEN** `stats.pending_count` 等于 `pending` 数组长度，`stats.judging_count` 等于 `judging` 数组长度，`stats.completed_today` 为当天完成的评测总数

### Requirement: 全局队列页面

系统 SHALL 提供前端页面 `/queue`，展示全局评测队列状态，面向所有访客开放（无需登录）。

排序规则（与 API 相反，按时间倒序，越靠近上端越新）：
- 正在评测：按 `judge_started_at` 降序（最新开始的在上）
- 排队中：按 `submitted_at` 降序（最新提交的在上）
- 最近完成：按 `judge_finished_at` 降序（最新完成的在上）

每个卡片/行显示：提交 ID（可截断）、题目编号和标题、语言、提交者用户名、提交时间。
正在评测的项目额外显示开始评测时间和持续时间。
已完成的项目额外显示得分和完成时间。

页面 SHALL 优先通过 SSE（`GET /api/v1/queue/events` 管理员）接收队列变更通知，收到 `queue:changed` 事件时立即调用 `GET /api/v1/queue` 刷新全量数据。当 SSE 不可用时 SHALL 降级到每 2 秒轮询 `GET /api/v1/queue` 刷新状态。队列页不维护独立的 1s 时钟计时器，ui 更新由 SSE 事件或轮询触发的 Vue 重渲染驱动。

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
