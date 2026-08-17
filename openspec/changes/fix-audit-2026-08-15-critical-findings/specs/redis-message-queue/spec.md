## ADDED Requirements

### Requirement: At-least-once 评测投递
评测任务与结果队列消费 SHALL 采用 processing 列表确认机制，重复投递 MUST 被 `submission_id` + `rejudge_seq` 幂等逻辑吸收。

#### Scenario: 消息重复到达
- **WHEN** 同一 `submission_id` + `rejudge_seq` 的任务或结果被处理两次
- **THEN** 第二次处理不得覆盖更新的状态或重复累计统计
