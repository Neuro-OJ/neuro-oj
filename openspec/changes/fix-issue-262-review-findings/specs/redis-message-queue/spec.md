## MODIFIED Requirements

### Requirement: 评测任务 Producer

系统 SHALL 提供 `pushJudgeTask()` 函数，将评测任务推送到 Redis 队列
`noj:judge:queue`。

评测主队列 SHALL 有一个明确的最大待评测数量上限。容量判断与成功入队 MUST 在同一个 Redis 原子操作中完成；并发 producer 不得通过竞态使主队列超过该上限。

#### Scenario: 推送评测任务

- **WHEN** 调用 `pushJudgeTask(task)` 传入有效的 JudgeTask 对象且主队列未满
- **THEN** 系统将任务 JSON 序列化后 LPUSH 到
  `noj:judge:queue`，返回队列长度（LPUSH 返回值）

#### Scenario: Redis 不可用时推送

- **WHEN** 调用 `pushJudgeTask()` 但 Redis 连接已断开
- **THEN** 系统抛出错误，调用方捕获后向用户返回服务不可用响应

#### Scenario: 队列已满时拒绝推送

- **WHEN** 主队列长度已达到最大待评测数量
- **THEN** 系统拒绝该任务，不得向主队列写入消息，并返回可重试的队列已满错误

#### Scenario: 并发入队不突破容量上限

- **WHEN** 多个 producer 并发推送且主队列接近最大容量
- **THEN** 每个任务的容量判断与 LPUSH 按 Redis 原子顺序执行，成功入队后的主队列长度不得超过上限
