## ADDED Requirements

### Requirement: 竞赛 SSE 隐藏 user_id

`GET /api/v1/contests/:id/events` 推送 `contest:submission:created` 事件时，对非 admin 订阅者 SHALL 隐藏事件中的 `user_id` 字段，避免实时泄露“谁在提交哪题”。

#### Scenario: 非 admin 收到脱敏事件

- **WHEN** 普通用户订阅竞赛 SSE 且收到 `contest:submission:created` 事件
- **THEN** 事件数据不包含 `user_id`（或该字段为 null）

#### Scenario: admin 收到完整事件

- **WHEN** admin 订阅同一竞赛 SSE
- **THEN** 事件数据包含完整 `user_id`
