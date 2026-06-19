## ADDED Requirements

### Requirement: Redis 连接管理

系统 SHALL 在启动时建立与 Redis 的连接，并在 `/health` 端点暴露连接状态。

#### Scenario: 连接成功

- **WHEN** noj-core 启动且 Redis 服务可用（默认 `redis://127.0.0.1:6379`）
- **THEN** 系统通过 ioredis 建立连接并执行 PING 验证，控制台输出连接成功日志

#### Scenario: 连接失败

- **WHEN** noj-core 启动但 Redis 服务不可达
- **THEN** 系统输出连接失败警告日志，`GET /health` 返回 `"redis": "error"`

#### Scenario: 健康检查

- **WHEN** GET `/health` 且 Redis 连接正常
- **THEN** 响应 JSON 包含 `"redis": "ok"`

### Requirement: 评测任务 Producer

系统 SHALL 提供 `pushJudgeTask()` 函数，将评测任务推送到 Redis 队列
`noj:judge:queue`。

#### Scenario: 推送评测任务

- **WHEN** 调用 `pushJudgeTask(task)` 传入有效的 JudgeTask 对象
- **THEN** 系统将任务 JSON 序列化后 LPUSH 到
  `noj:judge:queue`，返回任务在队列中的位置

#### Scenario: Redis 不可用时推送

- **WHEN** 调用 `pushJudgeTask()` 但 Redis 连接已断开
- **THEN** 系统抛出错误，调用方捕获后向用户返回服务不可用响应

### Requirement: 评测任务消息格式

推送的评测任务 JSON SHALL 包含以下字段：

| 字段                 | 类型    | 必须 | 说明                   |
| -------------------- | ------- | ---- | ---------------------- |
| submission_id        | string  | 是   | 提交 UUID              |
| problem_id           | string  | 是   | 题目 UUID              |
| judge_image          | string  | 是   | 题目定义的 Docker 镜像 |
| judge_command        | string  | 是   | 题目定义的评测命令     |
| support_package_path | string  | 否   | 支持包 zip 路径        |
| language             | string  | 是   | 编程语言标识           |
| code                 | string  | 是   | 用户源代码             |
| file_name            | string  | 否   | 用户文件名             |
| time_limit_ms        | integer | 是   | 时间限制               |
| memory_limit_mb      | integer | 是   | 内存限制               |

#### Scenario: 完整任务消息

- **WHEN** 推送一个包含所有必填字段的评测任务
- **THEN** 队列中的 JSON 字符串包含
  submission_id、problem_id、judge_image、judge_command、language、code、time_limit_ms、memory_limit_mb

### Requirement: 评测结果通道约定

评测结果 SHALL 通过 Redis 通道 `noj:judge:results:{submission_id}`
返回，格式如下：

| 字段          | 类型    | 说明               |
| ------------- | ------- | ------------------ |
| submission_id | string  | 提交 UUID          |
| status        | string  | 评测状态（自定义） |
| score         | integer | 得分 ×100          |
| output        | string  | 评测命令原始输出   |
| details       | object  | 结构化详情         |
| time_ms       | integer | 总耗时             |
| memory_kb     | integer | 峰值内存           |

#### Scenario: 结果通道命名

- **WHEN** 评测 Worker 完成 submission_id 为 `abc-123` 的评测
- **THEN** Worker 将结果 PUBLISH 到通道 `noj:judge:results:abc-123`
