## Purpose

定义评测消息队列的可靠性保障规范，通过 processing 列表确认、超时重投与幂等消费实现 at-least-once 投递语义。

## Requirements

### Requirement: 任务处理中队列与超时重投
系统 SHALL 在 judge 弹出评测任务后将其移入 `noj:judge:queue:processing` 列表，并在评测完成或判定失败后 LREM 确认移除；任何在 processing 列表停留超过 10 分钟的任务 MUST 被重投回主队列。

#### Scenario: judge 在处理中崩溃
- **WHEN** judge 弹出任务后崩溃且未确认完成
- **THEN** 超时扫描将任务重投回 `noj:judge:queue`，另一个 judge 可重新评测

#### Scenario: 评测正常完成
- **WHEN** judge 完成评测并推送结果
- **THEN** 任务从 processing 列表移除，不得再次重投

### Requirement: 结果队列可靠消费
noj-core 消费评测结果时 SHALL 将消息移入 `noj:judge:results:processing`，写库成功后 LREM 确认；写库失败 MUST 将原始消息重投回结果队列或写入死信并在有限次数内重试。

#### Scenario: 结果写库失败
- **WHEN** noj-core 弹出结果后数据库写入失败
- **THEN** 结果消息被重新投递，提交不得永久停留在 judging

#### Scenario: 重复结果幂等
- **WHEN** 同一提交的相同结果被重复投递
- **THEN** 评测结果与统计数据只应用一次
