## Purpose

定义基于 Redis Pub/Sub 的事件总线规范，用于跨进程广播评测状态变更和队列变更事件，支持多实例部署。

## Requirements

### Requirement: Redis Pub/Sub 事件发布

系统 SHALL 提供 `publishEvent(channel, message)` 函数，将事件消息发布到 Redis Pub/Sub 频道。

- 发布操作 SHALL 复用现有 `getRedis()` 共享连接
- 发布操作 SHALL 为 fire-and-forget（不阻塞调用方），不 await 也不抛出异常
- 发布前 SHALL 检查 `subscriberReady` 标志，未就绪时静默跳过（丢失的事件由前端轮询 fallback 补齐）
- 频道命名 SHALL 遵循 `noj:events:<domain>` 前缀规则

#### Scenario: 发布提交状态变更事件

- **WHEN** Consumer 成功持久化评测结果后调用 `publishEvent("noj:events:submission:<id>", msg)`
- **THEN** Redis 将该消息广播到所有订阅了该频道的连接

#### Scenario: 发布队列变更事件

- **WHEN** 提交入队或评测完成后调用 `publishEvent("noj:events:queue", msg)`
- **THEN** Redis 将该消息广播到所有订阅了 `noj:events:queue` 频道的连接

#### Scenario: 发布失败不阻塞调用方

- **WHEN** `publishEvent()` 执行但 Redis 连接异常或 `subscriberReady` 为 false
- **THEN** 系统记录日志但不抛异常，调用方继续执行

#### Scenario: 订阅者未就绪时跳过发布

- **WHEN** `initEventSubscriber()` 尚未完成（`subscriberReady === false`）
- **THEN** `publishEvent()` 直接 return，不写入 Redis（丢失事件由前端轮询 fallback 补齐）

### Requirement: Redis Pub/Sub 订阅与本地分发

系统 SHALL 提供 `initEventSubscriber()` 函数，创建独立 Redis 连接并订阅 `noj:events:*` 模式，收到消息后分发到本地 EventEmitter。

- Subscriber SHALL 使用 `createPubSubRedis()` 创建独立连接
- Subscriber SHALL 使用 `PSUBSCRIBE noj:events:*` 订阅全局事件模式
- 收到消息后 SHALL emit 到本地 EventEmitter，事件名为 Redis 频道名

#### Scenario: 初始化 EventSubscriber

- **WHEN** `main.ts` 调用 `initEventSubscriber()`
- **THEN** 系统创建独立 Redis 连接并执行 PSUBSCRIBE，控制台输出初始化日志

#### Scenario: 收到 Redis 事件后本地分发

- **WHEN** Redis Subscriber 收到 `noj:events:submission:<id>` 频道的消息
- **THEN** 本地 EventEmitter emit 同名事件，所有通过 `onEvent()` 注册的回调被调用

### Requirement: 本地事件订阅接口

系统 SHALL 提供 `onEvent(channel, callback)` 函数供 SSE handler 注册事件监听，返回 unsubscribe 函数。

- `channel` 为精确的 Redis 频道名（如 `"noj:events:submission:<id>"`），不支持 glob 模式匹配
- SSE handler 在连接建立时调用 `onEvent`
- SSE handler 在断开时调用返回的 unsubscribe

#### Scenario: SSE handler 订阅提交事件

- **WHEN** SSE handler 调用 `onEvent("noj:events:submission:<id>", callback)`
- **THEN** 当 Redis Subscriber 收到匹配频道消息时，callback 被调用；调用返回的 unsubscribe 后，callback 不再被调用

### Requirement: 独立 Pub/Sub Redis 连接

`createPubSubRedis()` SHALL 创建独立 Redis 连接，配置为 `lazyConnect: true`、`enableOfflineQueue: false`。

- 该连接 SHALL 不同于 `getRedis()`（共享 producer）和 `createConsumerRedis()`（BRPOP consumer）
- Pub/Sub 连接 SHALL 配置无限重试（永不返回 null retryStrategy）

#### Scenario: Pub/Sub 连接断开后自动重连

- **WHEN** Pub/Sub Redis 连接断开
- **THEN** 系统按指数退避自动重连，重连成功后自动恢复 PSUBSCRIBE
