## Why

当前 noj-core 的 MQ Consumer 收到评测结果后仅写入数据库，前端只能通过 `setInterval` 盲轮询（提交详情 1500ms、队列状态 2000ms）。每次轮询都产生一次完整的 HTTP 往返和数据库查询，延迟高且资源浪费。引入 SSE（Server-Sent Events）推送后，评测结果和队列变更可实时通知前端，显著降低延迟，减少无效请求。

## What Changes

- 后端新增基于 Redis Pub/Sub 的事件总线（`event-bus.ts`），Consumer/Producer 在关键状态变更时发布事件
- 后端新增 SSE 端点：`GET /api/v1/submissions/:id/events`（提交状态推送）和 `GET /api/v1/queue/events`（队列变更推送），复用现有 Auth Header 认证链
- 前端新增 `useEventSource` composable，自动处理 SSE 连接和 fallback 降级
- 前端 `submissions/[id].vue` 和 `queue.vue` 集成 SSE，保留现有轮询代码作为自动 fallback
- 无 **BREAKING** 变更：所有 REST API 保持不变，轮询 fallback 确保零 degrade

## Capabilities

### New Capabilities
- `sse-event-bus`: 基于 Redis Pub/Sub 的事件发布-订阅系统，支持 `noj:events:submission:<id>` 和 `noj:events:queue` 频道，提供 `publishEvent`/`onEvent` 接口
- `sse-endpoints`: SSE 流式端点，通过 Hono `streamSSE` 实现提交状态和队列变更的实时推送，认证复用现有 `authMiddleware`
- `sse-polling-fallback`: 前端 `useEventSource` composable，SSE 优先、轮询兜底的自动降级策略；10s 连接超时或 `onerror` 触发时自动切换到轮询

### Modified Capabilities
- `submission-status-tracking`: 提交状态变更时通过 SSE 实时推送，替代纯轮询
- `queue-overview`: 队列变更时通过 SSE 通知即时刷新，替代纯轮询
- `redis-message-queue`: 现有 List 队列不变，新增 Pub/Sub 维度用于事件广播

## Impact

- **noj-core**: 新增 `lib/event-bus.ts`、`routes/sse.ts`；修改 `mq/consumer.ts`、`mq/connection.ts`、`services/submissions.ts`、`app.ts`、`main.ts`
- **noj-ui**: 新增 `composables/useEventSource.ts`；修改 `pages/submissions/[id].vue`、`pages/queue.vue`
- **Redis**: 新增 1 个 Pub/Sub 连接（`createPubSubRedis`），3 个频道（`noj:events:*`）
- **Nitro 代理**: 无需修改（SSE 是标准 HTTP，`proxyRequest` 直接透传 streaming response）
- **认证**: 无需新增 token 机制（SSE 同源请求，Cookie 自动携带，Nitro 代理注入 Auth Header）
- **无新依赖**: Hono v4 已内置 `hono/streaming`，ioredis 已支持 `publish`/`psubscribe`
