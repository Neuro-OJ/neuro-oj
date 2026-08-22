## MODIFIED Requirements

### Requirement: 提交状态 SSE 端点

系统 SHALL 提供 `GET /api/v1/submissions/:id/events` 端点，通过 SSE 流式推送提交状态变更。

- 端点 SHALL 受 JWT 认证保护（复用 authMiddleware）
- 路由调用提交详情服务时 MUST 传递当前请求的 userId、userRole 和 Hono Context，
  使 `submission:read_all` 等实时 RBAC 权限可被正确判断
- 响应 Content-Type SHALL 为 `text/event-stream`
- 当 `noj:events:submission:<id>` 频道有事件时 SHALL 以 `submission:updated` 事件名推送
- 如果提交已处于终态（`finished`/`error`），连接建立后立即推送一次 `submission:updated` 事件并关闭连接

#### Scenario: 管理员订阅他人提交

- **WHEN** 已认证用户通过实时 RBAC 具备 `submission:read_all` 权限，并 GET 他人提交的 SSE 端点
- **THEN** 路由将完整认证上下文传递给提交详情服务，连接建立成功并返回状态事件流

#### Scenario: 提交状态实时推送

- **WHEN** 已登录用户 GET `/api/v1/submissions/<id>/events` 且 SSE 连接建立
- **THEN** 系统返回 `text/event-stream`，状态变更时推送 `submission:updated` 事件

#### Scenario: 已终态提交连接

- **WHEN** 提交已 finished/error 时连接 SSE
- **THEN** 系统立即推送一次 `submission:updated` 事件并关闭连接

#### Scenario: 未认证用户访问 SSE

- **WHEN** 客户端未提供 Authorization 头 GET `/api/v1/submissions/<id>/events`
- **THEN** 系统返回 401

#### Scenario: 客户端断连后的清理

- **WHEN** SSE 连接断开（浏览器关闭/网络断开）
- **THEN** 系统取消对应的事件订阅，停止心跳定时器

#### Scenario: 心跳保持连接

- **WHEN** SSE 连接空闲超过 30 秒
- **THEN** 系统自动发送 `event: keepalive` 事件防止代理/中间件超时关闭连接
