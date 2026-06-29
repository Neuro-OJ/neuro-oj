## ADDED Requirements

### Requirement: Redis Pub/Sub 事件频道

系统 SHALL 新增以下 Redis Pub/Sub 频道用于事件广播，与现有 List 队列（`noj:judge:queue`、`noj:judge:results`）互补：

| 频道 | 发布时机 | 说明 |
|------|----------|------|
| `noj:events:submission:<submission_id>` | Consumer 持久化评测结果后 | 单提交状态变更 |
| `noj:events:queue` | 提交入队 / 评测完成 / 状态变更 | 全局队列变更 |

- Pub/Sub 频道 SHALL 不影响现有 LPUSH/BRPOP 队列功能
- 发布操作 SHALL 复用共享 Redis 连接（`getRedis()`）

#### Scenario: 提交状态变更时发布事件

- **WHEN** Consumer 调用 `saveEvaluationResult()` 成功后
- **THEN** 系统发布 JSON 格式消息到 `noj:events:submission:<submission_id>` 频道

#### Scenario: 队列变更时发布事件

- **WHEN** `pushJudgeTask` 将新提交入队成功 或 Consumer 持久化评测结果成功
- **THEN** 系统发布 JSON 格式消息到 `noj:events:queue` 频道

#### Scenario: 现有 List 队列不受影响

- **WHEN** Pub/Sub 功能启用
- **THEN** `noj:judge:queue` 和 `noj:judge:results` 的 LPUSH/BRPOP 行为不变，所有现有评测流程正常工作
