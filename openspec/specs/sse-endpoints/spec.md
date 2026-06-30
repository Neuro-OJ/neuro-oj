## Purpose

定义 Server-Sent Events（SSE）端点规范，用于向浏览器实时推送评测状态变更和队列变更通知。

## Requirements

### Requirement: 提交状态 SSE 端点

系统 SHALL 提供 `GET /api/v1/submissions/:id/events` 端点，通过 SSE 流式推送提交状态变更。

- 端点 SHALL 受 JWT 认证保护（复用 authMiddleware）
- 响应 Content-Type SHALL 为 `text/event-stream`
- 当 `noj:events:submission:<id>` 频道有事件时 SHALL 以 `submission:updated` 事件名推送，data 为 `{ type: "submission:updated", id: "<submission_id>" }`（仅作触发通知，不包含完整提交数据）
- 每 30 秒 SHALL 发送心跳事件（`keepalive`）
- 如果提交已处于终态（`finished`/`error`），连接建立后立即推送一次 `submission:updated` 事件并关闭连接

#### Scenario: 提交状态实时推送

- **WHEN** 已登录用户 GET `/api/v1/submissions/<id>/events` 且 SSE 连接建立
- **THEN** 系统返回 `text/event-stream` 响应，当评测状态变更时推送 `event: submission:updated`，data 为 `{ type: "submission:updated", id: "<id>" }`，前端收到后通过 REST 拉取全量数据

#### Scenario: 已终态提交连接

- **WHEN** 提交已 finished/error 时连接 SSE
- **THEN** 系统立即推送 `submission:updated` 事件并关闭 SSE 连接

#### Scenario: 未认证用户访问 SSE

- **WHEN** 客户端未提供 Authorization 头 GET `/api/v1/submissions/<id>/events`
- **THEN** 系统返回 401

#### Scenario: 客户端断连后的清理

- **WHEN** SSE 连接断开（浏览器关闭/网络断开）
- **THEN** 系统取消对应的事件订阅，停止心跳定时器

#### Scenario: 心跳保持连接

- **WHEN** SSE 连接空闲超过 30 秒
- **THEN** 系统自动发送 `event: keepalive` 事件防止代理/中间件超时关闭连接

### Requirement: 队列状态 SSE 端点

系统 SHALL 提供 `GET /api/v1/queue/events` 端点，通过 SSE 流式推送队列变更通知。

- 端点 SHALL 受 JWT 认证保护（复用 authMiddleware），登录用户可访问
- 当 `noj:events:queue` 频道有事件时 SHALL 以 `queue:changed` 事件名推送
- 推送的 data SHALL 为 JSON 格式的 `{ type: "queue:changed" }`

#### Scenario: 已登录用户订阅队列变更

- **WHEN** 已登录用户 GET `/api/v1/queue/events` 且 SSE 连接建立
- **THEN** 系统返回 `text/event-stream` 响应，队列变更时推送 `event: queue:changed`

#### Scenario: 未登录用户被拒绝

- **WHEN** 未登录用户 GET `/api/v1/queue/events`
- **THEN** 系统返回 401 UNAUTHORIZED

#### Scenario: 连接建立时推送当前状态

- **WHEN** 管理员 SSE 连接建立
- **THEN** 系统立即推送一次 `event: queue:changed`，data 为 `{ type: "queue:changed" }`，通知前端刷新当前队列状态（MQTT Retain 语义）

#### Scenario: 队列事件触发全量刷新

- **WHEN** 前端收到 `queue:changed` 事件
- **THEN** 前端调用 `GET /api/v1/queue` 获取最新全量队列数据
