## Purpose

定义 Neuro OJ 全链路 E2E 测试规范，包括测试框架、提交流程验证、结果消费验证、幂等性、容错性，以及全栈 Docker Compose 编排测试。

## Requirements

### Requirement: 全链路 E2E 测试框架

系统 SHALL 提供全链路 E2E 测试，验证从提交 → 评测 → 结果持久化的完整流程。

#### Scenario: 测试环境

- **WHEN** 运行全链路 E2E 测试
- **THEN** 需要以下服务可用：Redis、PostgreSQL（可通过 docker-compose 或环境变量配置）

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
- **THEN** 消息包含 `submission_id`、`judge_image`、`judge_command`、`code`、`time_limit_ms`、`memory_limit_mb` 等所有必要字段

### Requirement: 结果消费验证

系统 SHALL 验证评测结果的消费和持久化流程。

#### Scenario: 模拟结果消费

- **WHEN** 向 Redis 结果队列 `noj:judge:results` 推送合法的 `JudgeResult` JSON
- **THEN** 结果消费者 `startResultConsumer` 正确解析并调用 `saveEvaluationResult` 持久化

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

### Requirement: 全栈 Docker Compose 编排测试

系统 SHALL 提供 Docker Compose 编排文件，支持一键启动完整评测栈执行 E2E 测试。

#### Scenario: 一键启动所有服务

- **WHEN** 执行 `docker compose -f docker-compose.e2e.yml up -d`
- **THEN** noj-core、PostgreSQL、Redis、noj-judge 全部启动并可用
- **THEN** noj-core API 在配置端口上响应健康检查请求

#### Scenario: 全栈测试门控

- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 未设置
- **THEN** `deno task test:e2e` 跳过所有全栈 E2E 测试
- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 已设置
- **THEN** `deno task test:e2e` 启动测试栈并执行全链路测试

### Requirement: 基础提交 Accepted 验证

系统 SHALL 验证正确代码在完整提交流程后获得 Accepted 结果。

#### Scenario: 正确代码提交验证

- **WHEN** 通过 REST API 提交正确实现的代码
- **THEN** submission 状态最终变为 `finished`
- **THEN** evaluation_result 的 verdict 为 `Accepted`

### Requirement: 错误代码 Wrong Answer 验证

系统 SHALL 验证有 bug 的代码在完整提交流程后获得 Wrong Answer 结果。

#### Scenario: 错误代码提交验证

- **WHEN** 通过 REST API 提交含有逻辑错误的代码
- **THEN** submission 状态最终变为 `finished`
- **THEN** evaluation_result 的 verdict 为 `WrongAnswer`

### Requirement: 超时代码 TLE 验证

系统 SHALL 验证死循环/超时代码在完整提交流程后获得 Time Limit Exceeded 结果。

#### Scenario: 超时代码提交验证

- **WHEN** 通过 REST API 提交含死循环的代码
- **THEN** submission 状态最终变为 `finished`
- **THEN** evaluation_result 的 verdict 为 `Time Limit Exceeded`

### Requirement: MQ 消息可靠性验证

系统 SHALL 验证从提交到结果回写的完整 MQ 消息链路不丢不重。

#### Scenario: 完整消息链路

- **WHEN** 提交代码完成全链路评测
- **THEN** 评测结果被 noj-core 正确消费并持久化到 PostgreSQL
- **THEN** 同一消息重复投递时不会产生重复记录

### Requirement: 无效消息容错验证

系统 SHALL 验证系统在 MQ 中出现无效消息时能正确容错。

#### Scenario: 非法 JSON 不阻塞后续消息

- **WHEN** 向结果队列手动推送一条非法 JSON
- **THEN** noj-core 消费者记录错误日志并跳过该消息
- **THEN** 下一条合法消息可被正常消费

### Requirement: 测试资源自动清理

系统 SHALL 在测试结束后自动清理所有测试资源。

#### Scenario: 测试后清理

- **WHEN** 全栈 E2E 测试完成（成功或失败）
- **THEN** `docker compose down -v` 被调用，移除所有容器和卷
- **THEN** 无残留的测试容器或 MQ 消息

#### Scenario: 调试模式不清理

- **WHEN** 指定 `--no-cleanup` 或 `E2E_NO_CLEANUP=1`
- **THEN** 测试结束后保留容器和卷，便于调试
