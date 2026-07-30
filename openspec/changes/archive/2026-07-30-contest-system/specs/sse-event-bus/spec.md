## ADDED Requirements

### Requirement: 竞赛事件频道

系统 SHALL 在 `Channels` 常量中新增以下 Redis Pub/Sub 频道：

- `Channels.contestRanking(contestId)` — 频道名 `noj:events:contest:<contest_id>:ranking`
- `Channels.contestSubmission(contestId)` — 频道名 `noj:events:contest:<contest_id>:submission`

#### Scenario: 评测结果写入后触发竞赛排名事件

- **WHEN** 消费者成功持久化评测结果，且该 `submission.contest_id` 非 NULL
- **THEN** 系统调用 `publishEvent(Channels.contestRanking(contestId), msg)` 推送排名变更事件

#### Scenario: 竞赛提交创建后触发事件

- **WHEN** `createContestSubmission` 成功创建提交并入队
- **THEN** 系统调用 `publishEvent(Channels.contestSubmission(contestId), msg)` 推送新提交事件

### Requirement: 竞赛 SSE 端点

系统 SHALL 提供 `GET /api/v1/contests/:id/events` SSE 端点，推送竞赛实时事件。

- 连接建立时发送当前排名快照
- 订阅 `Channels.contestRanking(id)` 推送排名变更，限流 ≥ 5s
- 订阅 `Channels.contestSubmission(id)` 推送新提交通知
- 复用现有 SSE 模式：`streamSSE` + 30s keepalive + 300s safety timer
- OI 竞赛 running 期间仅向参赛者推送自身数据

#### Scenario: ICPC 竞赛 SSE 推送排名更新

- **WHEN** ICPC 竞赛中有新的 AC 提交导致排名变化
- **THEN** SSE 客户端收到 `contest:ranking:updated` 事件，前端刷新排名数据

#### Scenario: 竞赛 SSE 连接断开自动清理

- **WHEN** 客户端断开 SSE 连接
- **THEN** `closeStream()` 清除定时器、keepalive interval、取消 `onEvent` 订阅
