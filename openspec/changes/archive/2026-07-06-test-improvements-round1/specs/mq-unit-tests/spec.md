## ADDED Requirements

### Requirement: MQ Producer 单元测试

系统 SHALL 为 `pushJudgeTask` 函数提供单元测试覆盖。

#### Scenario: 成功推送评测任务

- **WHEN** Redis 连接状态为 `ready` 且消息大小在限制内
- **THEN** `pushJudgeTask` 调用 `redis.lpush("noj:judge:queue", message)` 并返回队列长度
- **THEN** 序列化后的 JSON 可反序列化为合法的 `JudgeTask` 结构

#### Scenario: Redis 连接不可用时抛错

- **WHEN** Redis 连接状态不是 `ready`
- **THEN** `pushJudgeTask` 抛出 Error，消息包含 "Redis 连接不可用" 和当前状态

#### Scenario: 消息超过大小限制时抛错

- **WHEN** 序列化后的消息字节数超过 16MB
- **THEN** `pushJudgeTask` 抛出 Error，消息包含 "超过大小限制" 和实际字节数

### Requirement: MQ Consumer 单元测试

系统 SHALL 为结果消费者提供单元测试覆盖，验证 BRPOP 消费循环的容错行为。

#### Scenario: 收到合法 JudgeResult 时正确持久化

- **WHEN** 结果队列中存在合法的 `JudgeResult` JSON（包含 `submission_id`、`status`、`score`）
- **THEN** 消费者解析消息后调用 `saveEvaluationResult` 持久化到数据库
- **THEN** 对应 submission 状态更新为 `finished`

#### Scenario: 收到非法 JSON 时跳过并继续

- **WHEN** 结果队列中存在非法 JSON（如 `{invalid}`）
- **THEN** 消费者记录错误日志
- **THEN** 消费者跳过该消息，继续 BRPOP 等待下一条

#### Scenario: 缺少 submission_id 时跳过

- **WHEN** 结果队列中存在缺少 `submission_id` 字段的 JSON
- **THEN** 消费者记录错误日志并跳过该消息

#### Scenario: Redis 连接断开后自动重连

- **WHEN** BRPOP 过程中 Redis 连接断开
- **THEN** 消费者进入指数退避重连（1s → 2s → 4s → … → 30s 封顶）
- **THEN** 重连成功后恢复消费

### Requirement: fake Redis 测试基础设施

系统 SHALL 提供一个可复用的 fake Redis mock，支持 RESP 协议中 MQ 层所需的命令。

#### Scenario: 支持 LPUSH 和 BRPOP

- **WHEN** 测试通过 fake Redis 执行 `LPUSH queue msg`
- **THEN** fake Redis 将消息存入内存列表，返回 `+OK`
- **WHEN** 随后执行 `BRPOP queue <timeout>`
- **THEN** fake Redis 返回 `["queue", "msg"]`，满足 BRPOP 阻塞语义

#### Scenario: BRPOP 超时返回 null

- **WHEN** 在指定超时时间内没有消息入队
- **THEN** fake Redis 返回 nil 数组（表示超时），不阻塞测试进程

#### Scenario: 支持 PUBLISH

- **WHEN** 测试通过 fake Redis 执行 `PUBLISH channel msg`
- **THEN** fake Redis 返回 `:1`（integer 响应，表示订阅者数量）

#### Scenario: 从 submissions.test.ts 提取为公共模块

- **WHEN** 创建 `tests/mq/_setup.ts`
- **THEN** fake Redis（RESP 协议解析 + LPUSH/PING/BRPOP/PUBLISH 处理）从 `tests/services/submissions.test.ts` 提取并增强
