## Purpose

定义 Neuro OJ 评测消息队列的基础设施规范，包括 Redis
连接管理、评测任务发布（Producer）和结果回传通道约定。基于 ioredis
实现，队列名为 `noj:judge:queue`。

## Requirements

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
  `noj:judge:queue`，返回队列长度（LPUSH 返回值）

#### Scenario: Redis 不可用时推送

- **WHEN** 调用 `pushJudgeTask()` 但 Redis 连接已断开
- **THEN** 系统抛出错误，调用方捕获后向用户返回服务不可用响应

### Requirement: 评测任务消息格式

推送的评测任务 JSON SHALL 包含以下字段。支持包通过 `download_url` 传递。

| 字段            | 类型    | 必须 | 说明                             |
| --------------- | ------- | ---- | -------------------------------- |
| submission_id   | string  | 是   | 提交 UUID                        |
| problem_id      | string  | 是   | 题目 UUID                        |
| judge_image     | string  | 是   | 题目定义的 Docker 镜像           |
| judge_command   | string  | 是   | 题目定义的评测命令               |
| download_url    | string  | 否   | `noj-download://` 支持包下载 URL |
| language        | string  | 是   | 编程语言标识                     |
| code            | string  | 是   | 用户源代码                       |
| file_name       | string  | 否   | 用户文件名                       |
| time_limit_ms   | integer | 是   | 时间限制（毫秒）                 |
| memory_limit_mb | integer | 是   | 内存限制（MB）                   |

#### Scenario: 完整任务消息（download_url 模式）

- **WHEN** 推送一个包含 `download_url` 的评测任务
- **THEN** 队列中的 JSON 包含所有必填字段及 `noj-download://` URL

#### Scenario: 无支持包任务消息

- **WHEN** 推送一个不包含 `download_url` 的评测任务
- **THEN** judge 跳过支持包步骤，直接写入用户代码后执行

### Requirement: 评测结果通道约定

评测结果 SHALL 通过 Redis 列表 `noj:judge:results` 以 LPUSH/BRPOP
模式传递，格式如下：

| 字段          | 类型    | 必须 | 说明                        |
| ------------- | ------- | ---- | --------------------------- |
| submission_id | string  | 是   | 提交 UUID                   |
| status        | string  | 是   | 评测状态                    |
| score         | integer | 是   | 得分 ×100                   |
| output        | string  | 是   | 评测命令原始输出            |
| details       | object  | 是   | 结构化详情（含 cases 数组） |
| time_ms       | integer | 否   | 总耗时（毫秒）              |
| memory_kb     | integer | 否   | 峰值内存（KB）              |

details 中的 cases 数组每项包含：

| 字段            | 类型    | 必须 | 说明             |
| --------------- | ------- | ---- | ---------------- |
| case_id         | string  | 是   | 用例标识         |
| status          | string  | 是   | 该用例评测状态   |
| time_ms         | integer | 否   | 用例耗时（毫秒） |
| memory_kb       | integer | 否   | 用例内存（KB）   |
| input           | string  | 否   | 输入内容         |
| expected_output | string  | 否   | 期望输出         |
| actual_output   | string  | 否   | 实际输出         |

#### Scenario: 结果投递

- **WHEN** 评测 Worker 完成评测并组装 JudgeResult
- **THEN** Worker 将结果 JSON LPUSH 到列表 `noj:judge:results`

#### Scenario: 结果消费

- **WHEN** noj-core 通过 BRPOP 从 `noj:judge:results` 拉取到结果
- **THEN** 更新对应 submission 状态为 finished，写入 evaluation_results 表

### Requirement: 评测结果 Consumer

noj-core SHALL 在启动时运行结果消费者，通过 BRPOP 阻塞等待 `noj:judge:results`
列表中的评测结果，解析后持久化。

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

### Requirement: 提交状态流转扩展

提交状态流转 SHALL 扩展为：`pending → judging → finished`（正常流程）或
`pending → error`（入队失败）。

#### Scenario: 入队成功后状态变更

- **WHEN** pushJudgeTask 成功 LPUSH 任务到队列
- **THEN** 系统立即将 submission 状态从 pending 更新为 judging

#### Scenario: 评测完成后状态变更

- **WHEN** result consumer 成功消费结果并写入 evaluation_results
- **THEN** 系统将 submission 状态从 judging 更新为 finished

### Requirement: Redis Pub/Sub 事件频道

系统 SHALL 新增以下 Redis Pub/Sub 频道用于事件广播，与现有 List
队列（`noj:judge:queue`、`noj:judge:results`）互补：

| 频道                                    | 发布时机                       | 说明           |
| --------------------------------------- | ------------------------------ | -------------- |
| `noj:events:submission:<submission_id>` | Consumer 持久化评测结果后      | 单提交状态变更 |
| `noj:events:queue`                      | 提交入队 / 评测完成 / 状态变更 | 全局队列变更   |

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
- **THEN** `noj:judge:queue` 和 `noj:judge:results` 的 LPUSH/BRPOP
  行为不变，所有现有评测流程正常工作
