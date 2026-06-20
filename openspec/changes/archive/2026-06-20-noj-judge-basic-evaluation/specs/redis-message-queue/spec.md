## MODIFIED Requirements

### Requirement: 评测结果通道约定

评测结果 SHALL 通过 Redis 列表 `noj:judge:results` 以 LPUSH/BRPOP 模式传递，格式如下：

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| submission_id | string | 是 | 提交 UUID |
| status | string | 是 | 评测状态（Accepted / WrongAnswer / TimeLimitExceeded / MemoryLimitExceeded / RuntimeError / SystemError） |
| score | integer | 是 | 得分 ×100 |
| output | string | 是 | 评测命令 stdout/stderr 完整输出 |
| details | object | 是 | 结构化详情（含 cases 数组） |
| time_ms | integer | 否 | 总耗时（毫秒） |
| memory_kb | integer | 否 | 峰值内存（KB） |

details 中的 cases 数组每项包含：

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| case_id | string | 是 | 用例标识 |
| status | string | 是 | 用例状态 |
| time_ms | integer | 否 | 用例耗时 |
| memory_kb | integer | 否 | 用例内存 |
| input | string | 否 | 输入内容 |
| expected_output | string | 否 | 期望输出 |
| actual_output | string | 否 | 实际输出 |

#### Scenario: 结果投递

- **WHEN** 评测 Worker 完成评测并组装 JudgeResult
- **THEN** Worker 将结果 JSON LPUSH 到列表 `noj:judge:results`

#### Scenario: 结果消费

- **WHEN** noj-core 通过 BRPOP 从 `noj:judge:results` 拉取到结果
- **THEN** 更新对应 submission 状态为 finished，写入 evaluation_results 表

### Requirement: 评测任务消息格式

评测任务 JSON SHALL 包含以下字段。支持包通过 `support_package_base64` 以 Base64 编码传递。

| 字段                    | 类型    | 必须 | 说明                          |
| ----------------------- | ------- | ---- | ----------------------------- |
| submission_id           | string  | 是   | 提交 UUID                     |
| problem_id              | string  | 是   | 题目 UUID                     |
| judge_image             | string  | 是   | 题目定义的 Docker 镜像        |
| judge_command           | string  | 是   | 题目定义的评测命令            |
| support_package_base64  | string  | 否   | 支持包 zip 的 Base64 编码     |
| language                | string  | 是   | 编程语言标识                  |
| code                    | string  | 是   | 用户源代码                    |
| file_name               | string  | 否   | 用户文件名                    |
| time_limit_ms           | integer | 是   | 时间限制（毫秒）              |
| memory_limit_mb         | integer | 是   | 内存限制（MB）                |

#### Scenario: 完整任务消息（Base64 模式）

- **WHEN** 推送一个包含 support_package_base64 的评测任务
- **THEN** 队列中的 JSON 包含所有必填字段及 Base64 编码的支持包内容

#### Scenario: 无支持包任务消息

- **WHEN** 推送一个不包含 support_package_base64 的评测任务
- **THEN** judge 跳过支持包步骤，直接写入用户代码后执行

## ADDED Requirements

### Requirement: 评测结果 Consumer

noj-core SHALL 在启动时运行结果消费者，通过 BRPOP 阻塞等待 `noj:judge:results` 列表中的评测结果，解析后持久化。

#### Scenario: 消费评测结果

- **WHEN** 从 `noj:judge:results` BRPOP 获取到有效的 JudgeResult JSON
- **THEN** 系统更新 submissions 表状态为 finished，INSERT 到 evaluation_results 表（submission_id、status、score、output、details、time_ms、memory_kb）

#### Scenario: 结果 JSON 解析失败

- **WHEN** BRPOP 获取到格式非法的 JSON
- **THEN** 系统记录错误日志并跳过该条目，继续等待下一条

#### Scenario: 消费者与 HTTP 服务器并行

- **WHEN** noj-core 启动
- **THEN** result consumer 在独立异步上下文中运行，不阻塞 HTTP 请求处理

### Requirement: 提交状态流转扩展

提交状态流转 SHALL 扩展为：`pending → judging → finished`（正常流程）或 `pending → error`（入队失败）。

#### Scenario: 入队成功后状态变更

- **WHEN** pushJudgeTask 成功 LPUSH 任务到队列
- **THEN** 系统立即将 submission 状态从 pending 更新为 judging

#### Scenario: 评测完成后状态变更

- **WHEN** result consumer 成功消费结果并写入 evaluation_results
- **THEN** 系统将 submission 状态从 judging 更新为 finished
