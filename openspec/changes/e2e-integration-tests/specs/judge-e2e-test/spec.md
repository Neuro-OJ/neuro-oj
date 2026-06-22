## ADDED Requirements

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
- **THEN** evaluation_result 的 verdict 为 `Wrong Answer`

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
