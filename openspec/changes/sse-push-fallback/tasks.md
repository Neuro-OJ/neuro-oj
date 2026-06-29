## 1. Redis 基础设施

- [ ] 1.1 在 `connection.ts` 的 `RedisClient` 接口新增 `publish(channel: string, message: string): Promise<number>` 方法
- [ ] 1.2 在 `connection.ts` 新增 `createPubSubRedis()` 函数：独立 Redis 连接，`lazyConnect: true`、`enableOfflineQueue: false`、无限重试

## 2. EventBus 事件总线

- [ ] 2.1 新建 `lib/event-bus.ts`，实现 `publishEvent(channel, message)` 发布函数（复用 `getRedis().publish`）
- [ ] 2.2 实现 `initEventSubscriber()`：创建 Pub/Sub Redis 连接 → `PSUBSCRIBE noj:events:*` → `on('message')` 触发本地 EventEmitter
- [ ] 2.3 实现 `onEvent(pattern, callback)` 本地订阅接口，返回 unsubscribe 函数
- [ ] 2.4 在 `main.ts` 的 `startResultConsumerWithRetry()` 之后调用 `initEventSubscriber()`

## 3. SSE 端点

- [ ] 3.1 新建 `routes/sse.ts`，创建 Hono 实例 + authMiddleware，注册 `GET /api/v1/submissions/:id/events` 端点
- [ ] 3.2 实现提交状态 SSE handler：权限校验（提交者身份）→ `streamSSE` → `onEvent` 订阅 → `writeSSE` 推送 + 30s 心跳 + `onAbort` 清理
- [ ] 3.3 实现 `GET /api/v1/queue/events` 端点：admin 角色校验 → `streamSSE` → `onEvent` 订阅 queue 事件 → `writeSSE` 推送 + 心跳 + 清理
- [ ] 3.4 在 `deno.json` 添加 `hono/streaming` 导入映射：`"hono/streaming": "npm:/hono@^4/streaming"`
- [ ] 3.5 在 `app.ts` 注册 SSE 路由：`app.route("/", sse)`

## 4. 事件发布集成

- [ ] 4.1 在 `mq/consumer.ts` 的 `saveEvaluationResult()` 成功后，`publishEvent` 到 `noj:events:submission:<id>` 和 `noj:events:queue`
- [ ] 4.2 在 `services/submissions.ts` 的 `pushJudgeTask` 成功后，`publishEvent` 到 `noj:events:queue`
- [ ] 4.3 确保 `publishEvent` 使用 fire-and-forget（不 await），不阻塞主流程

## 5. 前端 useEventSource Composable

- [ ] 5.1 新建 `composables/useEventSource.ts`，实现 EventSource 连接 + 事件注册 + fallback 降级逻辑
- [ ] 5.2 实现 state 状态机（connecting → connected/fallback/disabled）
- [ ] 5.3 实现 fallback 触发条件：EventSource 不支持、10s 超时、onerror 事件
- [ ] 5.4 实现 `onUnmounted` 清理：关闭 EventSource + 停止 fallback 定时器

## 6. 前端页面集成

- [ ] 6.1 修改 `pages/submissions/[id].vue`：集成 `useEventSource`，SSE 优先推送，`pollSubmission` 作为 fallback `fetchFn`
- [ ] 6.2 修改 `pages/queue.vue`：集成 `useEventSource`，`queue:changed` 事件触发即时请求 `GET /api/v1/queue`，`fetchFn` 作为 2s fallback

## 7. 验证

- [ ] 7.1 启动 `docker compose up -d` + noj-core + noj-ui + noj-judge，提交代码后验证 SSE 实时推送
- [ ] 7.2 停止 noj-core，刷新页面验证自动降级到轮询 fallback
- [ ] 7.3 运行 `cd noj-core && deno task test` 确认现有测试全部通过
