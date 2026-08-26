## Purpose

定义 Server-Sent Events（SSE）端点规范，用于向浏览器实时推送评测状态变更和队列变更通知。
## Requirements
### Requirement: 提交状态 SSE 端点

系统 SHALL 提供 `GET /api/v1/submissions/:id/events` 端点，通过 SSE 流式推送提交状态变更。

- 端点 SHALL 受 JWT 认证保护（复用 authMiddleware）
- 路由调用提交详情服务时 MUST 传递当前请求的 userId、userRole 和 Hono Context，
  使 `submission:read_all` 等实时 RBAC 权限可被正确判断
- 响应 Content-Type SHALL 为 `text/event-stream`
- 当 `noj:events:submission:<id>` 频道有事件时 SHALL 以 `submission:updated` 事件名推送，data 为 `{ type: "submission:updated", id: "<submission_id>" }`（仅作触发通知，不包含完整提交数据）
- 每 30 秒 SHALL 发送心跳事件（`keepalive`）
- 如果提交已处于终态（`finished`/`error`），连接建立后立即推送一次 `submission:updated` 事件并关闭连接

#### Scenario: 管理员订阅他人提交

- **WHEN** 已认证用户通过实时 RBAC 具备 `submission:read_all` 权限，并 GET 他人提交的 SSE 端点
- **THEN** 路由将完整认证上下文传递给提交详情服务，连接建立成功并返回状态事件流

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

### Requirement: 公告变更全局 SSE 事件

系统 SHALL 在 `lib/event-bus.ts` 的 `Channels` 常量中新增全局频道 `noj:events:announcements`。公告服务层在创建、更新（含发布/下架）、删除成功后 SHALL 调用 `publishEvent(Channels.announcements, ...)` 广播变更（fire-and-forget，失败仅记日志，不阻塞写流程）。

系统 SHALL 提供公告 SSE 端点 `GET /api/v1/announcements/events`（需登录，注册于 `routes/announcements.ts` 内、`/:id` 参数路由之前，公开路由整体挂载于 sse 实例之前）：订阅该端点的客户端收到事件后以 SSE 事件名 `announcement:updated` 推送（data 仅作触发通知，不含公告完整数据，与 `queue:changed` 同模式）。

> **偏离说明（工程妥协）**：原设计在全局 SSE 端点（`routes/sse.ts`）注册监听，但 sse 实例挂载时带全局 `authMiddleware`，会拦截所有挂载在其后的公开路由（见 `app.ts` 挂载注释）。公告 SSE 端点因此注册在公告路由实例内并挂载于 sse 实例之前，行为等价（客户端订阅 `/api/v1/announcements/events` 即可收到广播）。详见 `design.md` D5。

#### Scenario: 发布公告触发广播

- **WHEN** 管理员创建或发布公告
- **THEN** `noj:events:announcements` 频道收到事件，订阅 `/api/v1/announcements/events` 的 SSE 客户端收到 `announcement:updated`

#### Scenario: 下架公告触发广播

- **WHEN** 管理员下架公告（`is_active=false`）
- **THEN** 已连接 SSE 客户端收到 `announcement:updated`（前端据此刷新轮播/列表）

#### Scenario: Redis 不可用时降级

- **WHEN** Redis 不可用（订阅者未就绪）
- **THEN** 公告写流程正常完成（publishEvent 跳过），前端通过页面加载/轮询 fallback 获取最新数据

### Requirement: 竞赛 SSE 隐藏 user_id

`GET /api/v1/contests/:id/events` 推送 `contest:submission:created` 事件时，对非 admin 订阅者 SHALL 隐藏事件中的 `user_id` 字段，避免实时泄露“谁在提交哪题”。

#### Scenario: 非 admin 收到脱敏事件

- **WHEN** 普通用户订阅竞赛 SSE 且收到 `contest:submission:created` 事件
- **THEN** 事件数据不包含 `user_id`（或该字段为 null）

#### Scenario: admin 收到完整事件

- **WHEN** admin 订阅同一竞赛 SSE
- **THEN** 事件数据包含完整 `user_id`

