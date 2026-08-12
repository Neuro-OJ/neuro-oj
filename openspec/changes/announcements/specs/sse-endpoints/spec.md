## ADDED Requirements

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
