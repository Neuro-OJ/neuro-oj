## Purpose

定义 SSE（Server-Sent Events）端点 E2E 测试规范，覆盖认证、连接、心跳、事件推送等行为验证。

## Requirements

### Requirement: 提交状态 SSE 端点 E2E 测试

测试 SHALL 验证 `GET /api/v1/submissions/:id/events` SSE 端点的连接、推送和断连行为。

#### Scenario: SSE 连接建立与心跳

- **WHEN** 已登录用户通过 `fetch` + `AbortSignal` 连接 `GET /api/v1/submissions/:id/events`
- **THEN** 响应 status 为 200
- **THEN** 响应 `Content-Type` 为 `text/event-stream`
- **THEN** 在 35 秒内收到 `event: keepalive` 事件

#### Scenario: 已终态提交立即推送

- **WHEN** 提交状态为 `finished`
- **WHEN** 用户连接该提交的 SSE 端点
- **THEN** 5 秒内接收到 `event: submission:updated` 事件
- **THEN** 连接自动关闭（`ReadableStream` 结束）

#### Scenario: 未认证用户返回 401

- **WHEN** 未携带 token 请求 `GET /api/v1/submissions/:id/events`
- **THEN** 返回 HTTP 401

### Requirement: 队列状态 SSE 端点 E2E 测试

测试 SHALL 验证队列 SSE 端点的认证保护与初始事件推送。

#### Scenario: 队列 SSE 端点认证保护

- **WHEN** 未登录用户请求 `GET /api/v1/queue/events`
- **THEN** 返回 HTTP 401

#### Scenario: 连接建立时推送初始状态

- **WHEN** 已登录用户首次连接 `GET /api/v1/queue/events`
- **THEN** 10 秒内收到 `event: queue:changed` 事件

### Requirement: 模拟事件发布验证

测试 SHALL 通过 Redis Pub/Sub 直接发布事件并验证 SSE 端点正确推送。

#### Scenario: Redis 发布触发 SSE 推送

- **WHEN** 测试代码向 Redis 频道 `noj:events:submission:<id>` 发布事件
- **WHEN** 用户 SSE 连接已建立
- **THEN** SSE 流中收到 `event: submission:updated` 事件
- **THEN** data 内容包含 `{ "type": "submission:updated", "id": "<id>" }`
