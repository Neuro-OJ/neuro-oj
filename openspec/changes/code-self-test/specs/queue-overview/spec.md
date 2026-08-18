## ADDED Requirements

### Requirement: 队列概览展示自测任务

系统 SHALL 在 `GET /api/v1/queue` 的 `pending`、`judging`、`recently_completed` 数组中展示自测任务，与正式提交共用同一队列。

自测条目 MUST 包含与正式条目相同的字段，并额外包含 `kind: "self_test"`；正式条目 SHOULD 包含 `kind: "submission"`（兼容缺省时可省略，前端按 `kind === "self_test"` 判断自测）。

`stats.pending_count` 与 `stats.judging_count` MUST 包含自测任务，保证计数与列表一致。

#### Scenario: 队列中存在自测 pending 任务

- **WHEN** 自测任务已入队且尚未被消费
- **THEN** `GET /api/v1/queue` 的 `pending` 数组包含该自测条目，`kind` 为 `self_test`

#### Scenario: 队列中存在自测 judging 任务

- **WHEN** 自测任务正在评测
- **THEN** `GET /api/v1/queue` 的 `judging` 数组包含该自测条目，`kind` 为 `self_test`

#### Scenario: 队列中存在自测完成记录

- **WHEN** 自测任务已完成
- **THEN** `GET /api/v1/queue` 的 `recently_completed` 数组可能包含该自测条目，`kind` 为 `self_test`

#### Scenario: 队列统计包含自测

- **WHEN** 队列中同时存在正式提交与自测任务
- **THEN** `stats.pending_count` 与 `stats.judging_count` 同时计入两者，数值与列表长度一致
