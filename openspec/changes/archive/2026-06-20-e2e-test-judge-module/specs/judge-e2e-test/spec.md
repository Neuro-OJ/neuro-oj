## ADDED Requirements

### Requirement: 全链路 E2E 测试框架

系统 SHALL 提供全链路 E2E 测试，验证从提交 → 评测 → 结果持久化的完整流程。

#### Scenario: 测试环境

- **WHEN** 运行全链路 E2E 测试
- **THEN** 需要以下服务可用：Redis、PostgreSQL（可通过 docker-compose
  或环境变量配置）

#### Scenario: 测试门控

- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 未设置
- **THEN** 全链路 E2E 测试被跳过

### Requirement: 提交流程验证

系统 SHALL 验证 `createSubmission` 创建评测任务并通过 MQ 发送。

#### Scenario: 提交后 MQ 出现消息

- **WHEN** 调用 `createSubmission` 创建合法提交
- **THEN** Redis 队列 `noj:judge:queue` 中出现对应的 `JudgeTask` JSON 消息
- **THEN** submission 状态为 `judging`

#### Scenario: 提交信息完整

- **WHEN** 从 MQ 拉取 `JudgeTask` 消息
- **THEN** 消息包含
  `submission_id`、`judge_image`、`judge_command`、`code`、`time_limit_ms`、`memory_limit_mb`
  等所有必要字段

### Requirement: 结果消费验证

系统 SHALL 验证评测结果的消费和持久化流程。

#### Scenario: 模拟结果消费

- **WHEN** 向 Redis 结果队列 `noj:judge:results` 推送合法的 `JudgeResult` JSON
- **THEN** 结果消费者 `startResultConsumer` 正确解析并调用
  `saveEvaluationResult` 持久化

#### Scenario: 状态流转验证

- **WHEN** 评测结果被持久化
- **THEN** 对应 submission 的状态从 `judging` 变为 `finished`
- **THEN** `evaluation_results` 表中插入对应的结果记录

### Requirement: 重复消费幂等性验证

系统 SHALL 验证结果消费者在重复消费时的幂等行为。

#### Scenario: 重复结果不重复插入

- **WHEN** 同一个 `submission_id` 的 `JudgeResult` 被消费两次
- **THEN** `evaluation_results` 表中只有一条对应记录
- **THEN** `submission` 状态仍为 `finished`

### Requirement: 非法结果容错

系统 SHALL 验证消费者对非法消息的容错能力。

#### Scenario: 非法 JSON

- **WHEN** 结果队列中出现非法 JSON
- **THEN** 消费者记录错误日志并跳过该消息
- **THEN** 消费者继续处理下一条消息，不崩溃

#### Scenario: 缺少 submission_id

- **WHEN** 结果队列中包含缺少 `submission_id` 的 JSON
- **THEN** 消费者记录错误日志并跳过该消息
