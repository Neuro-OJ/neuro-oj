## Context

当前 noj-core 的评测流程：用户提交代码 → `pushJudgeTask` LPUSH 到 Redis `noj:judge:queue` → noj-judge BRPOP 消费 → Docker 执行评测 → LPUSH 结果到 `noj:judge:results` → Consumer BRPOP 消费 → 写入 PostgreSQL。前端 `submissions/[id].vue` 和 `queue.vue` 通过 `setInterval`（1500ms/2000ms）轮询 REST API 获取更新，Consumer 持久化后无任何通知机制。

约束：
- 必须保留轮询作为 fallback
- 不能改变部署架构（不能新增端口，不能直连 noj-core）
- 不能新增外部依赖（Hono v4 和 ioredis 已有所需能力）
- 认证链路不变（Cookie → Nitro proxy → Authorization header）

## Goals / Non-Goals

**Goals:**
- 评测结果和队列变更通过 SSE 实时推送到浏览器，消除 1.5-2s 的轮询延迟
- SSE 流通过现有 Nitro 代理（`[...slug].ts`）透传，无需新端口
- 前端自动降级到轮询 fallback（SSE 不可用时零 degrade）
- 支持多实例部署（通过 Redis Pub/Sub 跨进程广播事件）

**Non-Goals:**
- 浏览器 → 服务端的双向通信（不需要 WebSocket）
- 消息离线缓存/重放（断开期间的更新走 fallback 轮询补齐）
- 非评测相关的实时推送（如即时聊天）

## Decisions

### Decision 1: SSE 而非 WebSocket

**选择**: SSE (Server-Sent Events)

**理由**:
| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 协议 | HTTP，透传 Nitro 代理 | 需升级握手，代理不支持 |
| 认证 | 复用 Cookie → Auth Header | 需额外 token/URL auth |
| 浏览器 API | EventSource（自动重连）| WebSocket（手动重连） |
| 部署 | 单端口 | 需额外端口或 WS 代理 |
| 方向 | 服务端→客户端（完全满足需求）| 双向（当前不需要） |

**替代方案考虑**: WebSocket 提供双向能力，但当前所有实时需求都是单向推送。SSE 实现更简单，代理兼容性更好。

### Decision 2: Redis Pub/Sub 而非内存 EventEmitter

**选择**: Redis Pub/Sub

**理由**:
- 当前已使用 Redis（List MQ），复用现有基础设施
- Pub/Sub 跨进程广播，多实例部署无需额外工作
- ioredis 内置 `publish`/`psubscribe`，零新依赖
- 发布端 fire-and-forget，不阻塞评测持久化

**替代方案考虑**: 内存 EventEmitter 零网络开销，但仅单进程生效。多实例部署时，SSE 连接落在实例 A、Consumer 在实例 B，B 发布的事件无法到达 A 的 SSE handler。

### Decision 3: 共享 Redis Subscriber + 本地 EventEmitter fan-out

**选择**: 一个 Redis PSUBSCRIBE 连接 → 分发到本地 EventEmitter → SSE handler 订阅本地 EventEmitter

**流程**:
```
Redis Pub/Sub → PSUBSCRIBE noj:events:* (单连接) → 本地 EventEmitter.emit()
                                                      │
                                          ┌───────────┴──────────┐
                                          ▼                      ▼
                                    SSE Handler A          SSE Handler B
```

**理由**:
- `PSUBSCRIBE` 独占 Redis 连接（ioredis subscribe 模式下连接不可复用）
- 为每个 SSE 客户端创建独立 Redis subscriber 成本高
- 本地 EventEmitter fan-out 是同步的，零延迟
- 单实例内无论多少个 SSE handler，只消耗 1 个 Redis 连接

### Decision 4: streamSSE 而非手动构造 SSE 响应

**选择**: 使用 Hono v4 `npm:hono/streaming` 的 `streamSSE` helper

**理由**:
- 自动处理 `text/event-stream` Content-Type 和 SSE 帧格式化
- `stream.writeSSE({ event, data })` 语义清晰
- `stream.onAbort()` 处理客户端断开
- `deno.json` 已映射 `hono/`，只需追加 `hono/streaming` 导入

### Decision 5: SSE 路由在 app.ts 注册，不修改 main.ts 升级逻辑

**选择**: SSE 路由作为标准 Hono GET handler 注册在 `app.ts` 中

**理由**: SSE 是纯 HTTP，不需要 WebSocket 升级。`streamSSE` 返回标准 Response，`app.fetch` 可直接处理。无需像 WebSocket 那样在 `main.ts` 中 bypass Hono。

## Risks / Trade-offs

- **[Risk] proxyRequest 可能缓冲 SSE 响应而非流式透传** → **Mitigation**: h3 的 `proxyRequest` 底层使用 `sendWebResponse` → `responseToWebEvent`，在 Deno runtime 下使用原生 `ReadableStream`，应流式处理。如验证失败，可在 `[...slug].ts` 中为 SSE 路径添加基于 `$fetch` + `response.body.pipeTo` 的专用流式转发。
- **[Risk] SSE 连接数过多导致文件描述符耗尽** → **Mitigation**: 当前场景用户量有限（每用户 1-2 个 tab）。未来可添加 SSE 连接数上限和 LRU 淘汰。
- **[Risk] Redis Pub/Sub 消息不持久化，无订阅者时丢弃** → **Mitigation**: 评测结果已持久化到 PostgreSQL。SSE 仅加速通知，丢失的消息由轮询 fallback 补齐。
- **[Trade-off] EventBus 的 Redis Subscriber 是启动时创建的单例，断开后不会自动重连** → 进入 degraded 模式（本地 EventEmitter 不工作，所有 SSE handler 收到 `error` 后自动降级到轮询 fallback）。后续可添加自动重连。
