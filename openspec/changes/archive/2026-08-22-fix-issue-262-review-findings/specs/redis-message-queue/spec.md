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

### Requirement: 评测结果 Consumer

noj-core SHALL 在启动时运行有界的评测结果消费者池。消费者数量 SHALL 通过
`RESULT_CONSUMER_CONCURRENCY` 配置，缺失、非正整数或超出 1-16 范围时使用默认值 4。
每个消费者使用独立 Redis 连接，但共享 `noj:judge:results:processing` 列表；单条消息仍
必须按 BRPOPLPUSH、处理、LREM 的顺序确认，保持 at-least-once 投递与既有幂等语义。

#### Scenario: 多连接并行消费

- **WHEN** 结果队列中存在多个有效结果且消费者池有空闲连接
- **THEN** 不同结果可以由不同消费者并行处理，单条结果不会被两个消费者同时确认

#### Scenario: 消费评测结果

- **WHEN** 从 `noj:judge:results` BRPOP 获取到有效的 JudgeResult JSON
- **THEN** 系统更新 submissions 表状态为 finished，INSERT 到 evaluation_results
  表（submission_id、status、score、output、details、time_ms、memory_kb）

#### Scenario: 结果 JSON 解析失败

- **WHEN** BRPOP 获取到格式非法的 JSON
- **THEN** 系统记录错误日志并跳过该条目，继续等待下一条

#### Scenario: 消费者与 HTTP 服务器并行

- **WHEN** noj-core 启动
- **THEN** result consumer 在独立异步上下文中运行，不阻塞 HTTP 请求处理

#### Scenario: 消费者并发配置无效

- **WHEN** `RESULT_CONSUMER_CONCURRENCY` 缺失、为 0、不是整数或大于 16
- **THEN** noj-core 使用 4 个结果消费者连接并正常启动

#### Scenario: 消费者池健康状态

- **WHEN** 消费者池中至少有一个 Redis 连接处于活跃消费状态
- **THEN** 健康检查中的结果消费者状态保持为活跃
