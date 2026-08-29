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

评测主队列 SHALL 有一个明确的最大待评测数量上限。容量判断与成功入队 MUST 在同一个
Redis 原子操作中完成；并发 producer 不得通过竞态使主队列超过该上限。

#### Scenario: 推送评测任务

- **WHEN** 调用 `pushJudgeTask(task)` 传入有效的 JudgeTask 对象
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
| details       | object  | 是   | 结构化详情                  |
| time_ms       | integer | 否   | 总耗时（毫秒）              |
| memory_kb     | integer | 否   | 峰值内存（KB）              |

当评测器提供测试点级结果时，`details.cases` SHALL 为数组。每项至少包含
`case_id` 与 `status`，并可包含以下字段：

| 字段            | 类型                 | 必须 | 说明                                                   |
| --------------- | -------------------- | ---- | ------------------------------------------------------ |
| case_id         | string               | 是   | 用例标识                                               |
| status          | string               | 是   | 该用例评测状态                                         |
| visibility      | `visible` | `hidden` | 否   | 用例可见性；省略时按 `visible` 处理                   |
| time_ms         | integer              | 否   | 用例耗时（毫秒）                                       |
| memory_kb       | integer              | 否   | 用例内存（KB）                                         |
| input           | string               | 否   | 输入内容；隐藏用例不得提供                             |
| expected_output | string               | 否   | 期望输出；隐藏用例不得提供                             |
| actual_output   | string               | 否   | 实际输出；隐藏用例不得提供                             |

评测器 SHALL 保持 `cases` 数组的顺序与实际执行顺序一致。对于
`visibility=hidden` 的用例，评测结果 MUST NOT 包含 `input`、`expected_output`
或 `actual_output`，避免向用户泄露隐藏数据；隐藏用例仍可返回状态、耗时和内存。

#### Scenario: 结果投递

- **WHEN** 评测 Worker 完成评测并组装 JudgeResult
- **THEN** Worker 将结果 JSON LPUSH 到列表 `noj:judge:results`

#### Scenario: 标准测试点结果

- **WHEN** 评测器为提交生成多个测试点结果
- **THEN** 结果在 `details.cases` 中按执行顺序返回，每项包含 `case_id`、`status`，并按可用性包含耗时、内存和可见输出字段

#### Scenario: 隐藏测试点不泄露输出

- **WHEN** 评测器返回 `visibility=hidden` 的测试点
- **THEN** 该测试点不包含输入、期望输出或实际输出，仅可包含状态、耗时和内存

#### Scenario: 结果消费

- **WHEN** noj-core 通过 BRPOP 从 `noj:judge:results` 拉取到结果
- **THEN** 更新对应 submission 状态为 finished，写入 evaluation_results 表

### Requirement: 评测结果 Consumer

noj-core SHALL 在启动时运行有界的评测结果消费者池。消费者数量 SHALL 通过
`RESULT_CONSUMER_CONCURRENCY` 配置，缺失、非正整数或超出 1-16 范围时使用默认值 4。
每个消费者使用独立 Redis 连接，但共享 `noj:judge:results:processing` 列表；单条消息仍
必须按 BRPOPLPUSH、处理、LREM 的顺序确认，保持 at-least-once 投递与既有幂等语义。

#### Scenario: 多连接并行消费

- **WHEN** 结果队列中存在多个有效结果且消费者池有空闲连接
- **THEN** 不同结果可以由不同消费者并行处理，单条结果不会被两个消费者同时确认

#### Scenario: 消费评测结果

- **WHEN** 从 `noj:judge:results` BRPOPLPUSH 获取到有效的 JudgeResult JSON
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

### Requirement: At-least-once 评测投递
评测任务与结果队列消费 SHALL 采用 processing 列表确认机制，重复投递 MUST 被 `submission_id` + `rejudge_seq` 幂等逻辑吸收。

#### Scenario: 消息重复到达
- **WHEN** 同一 `submission_id` + `rejudge_seq` 的任务或结果被处理两次
- **THEN** 第二次处理不得覆盖更新的状态或重复累计统计
