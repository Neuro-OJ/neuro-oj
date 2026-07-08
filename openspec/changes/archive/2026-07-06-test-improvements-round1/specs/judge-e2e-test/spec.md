## ADDED Requirements

### Requirement: 题目时间限制验证

系统 SHALL 验证题目的 `time_limit_ms` 实际约束了 Docker 容器中的代码执行时间。

#### Scenario: 超时限制强制生效

- **WHEN** 创建容器时设置 `time_limit_ms=500` 且容器内执行 `sleep 10`
- **THEN** 容器在超时后被 kill，`wait_container` 返回 `exit_code=-1`

#### Scenario: 宽松限制下正常完成

- **WHEN** 创建容器时设置 `time_limit_ms=10000` 且容器内执行 `print("done")`
- **THEN** 容器正常退出，`exit_code=0`，stdout 包含 "done"

### Requirement: 题目内存限制验证

系统 SHALL 验证题目的 `memory_limit_mb` 实际约束了 Docker 容器中的代码内存使用。

#### Scenario: 内存限制强制生效

- **WHEN** 创建容器时设置 `memory_limit_mb=50` 且容器内分配超过 50MB 内存
- **THEN** Docker OOM killer 终止进程，返回 `exit_code=137`

### Requirement: 全链路 Memory Limit Exceeded 验证

系统 SHALL 验证内存超限代码在完整提交流程后获得 Memory Limit Exceeded 结果。

#### Scenario: 内存超限代码提交验证

- **WHEN** 通过 REST API 提交含无限内存分配的代码
- **THEN** evaluation_result 的 verdict 为 `MemoryLimitExceeded`

### Requirement: 全链路 Runtime Error 验证

系统 SHALL 验证运行时错误代码在完整提交流程后获得 Runtime Error 结果。

#### Scenario: 运行时错误代码提交验证

- **WHEN** 通过 REST API 提交含 `sys.exit(1)` 的代码
- **THEN** evaluation_result 的 verdict 为 `RuntimeError`

#### Scenario: 语法错误代码提交验证

- **WHEN** 通过 REST API 提交含语法错误的代码
- **THEN** evaluation_result 的 verdict 为 `CompileError` 或 `RuntimeError`

### Requirement: CI E2E 工作流触发

系统 SHALL 在 CI 中自动化运行 E2E 测试，防止回归。

#### Scenario: Push 到 main 触发

- **WHEN** 代码被推送到 `main` 分支
- **THEN** E2E 工作流自动触发，执行全栈 E2E 测试

#### Scenario: PR 触发

- **WHEN** 创建指向 `main` 分支的 Pull Request
- **THEN** E2E 工作流自动触发，验证变更不引入回归

#### Scenario: 手动触发

- **WHEN** 通过 `workflow_dispatch` 手动触发
- **THEN** E2E 工作流执行全栈测试

### Requirement: 轮询提交结果超时

系统 SHALL 为 E2E 测试中的 `pollSubmission()` 提供合理的默认超时值。

#### Scenario: 默认超时足够完成评测

- **WHEN** 使用默认参数调用 `pollSubmission(token, submissionId)`
- **THEN** 最大等待时间为 30 秒（15 次重试 × 2 秒间隔）
- **THEN** 在 CI 负载较高时仍有足够窗口等待评测完成

### Requirement: Pipeline 测试端口配置

系统 SHALL 在 pipeline E2E 测试中正确使用 `BASE_URL` 环境变量。

#### Scenario: isJudgeAvailable 使用正确端口

- **WHEN** `isJudgeAvailable()` 检查 judge worker 可用性
- **THEN** 使用 `BASE_URL`（而非硬编码 `localhost:8000`）构建请求地址

## MODIFIED Requirements

### Requirement: 测试资源自动清理

系统 SHALL 在测试结束后自动清理所有测试资源。

#### Scenario: 测试后清理

- **WHEN** 全栈 E2E 测试完成（成功或失败）
- **THEN** `docker compose down -v` 被调用，移除所有容器和卷
- **THEN** 无残留的测试容器或 MQ 消息

#### Scenario: 调试模式不清理

- **WHEN** 指定 `--no-cleanup` 或 `E2E_NO_CLEANUP=1`
- **THEN** 测试结束后保留容器和卷，便于调试
