## MODIFIED Requirements

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
