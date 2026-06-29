## ADDED Requirements

### Requirement: useEventSource Composable

系统 SHALL 提供 `useEventSource` composable，集成 EventSource API 与自动轮询 fallback。

- composable SHALL 接受 `url`（SSE 端点）、`onEvent`（事件回调）、`fetchFn`（fallback 函数）、`fallbackIntervalMs`（fallback 间隔）参数
- composable SHALL 暴露 `state` ref（`"connecting" | "connected" | "fallback" | "disabled"`）
- 当 SSE 连接成功时 SHALL 停止 fallback 轮询
- 当 SSE 连接失败/断开时 SHALL 自动降级到 fallback 轮询
- 组件卸载（`onUnmounted`）时 SHALL 清理所有定时器和 EventSource 连接

#### Scenario: SSE 正常连接

- **WHEN** 浏览器支持 EventSource 且 SSE 端点返回 `text/event-stream`
- **THEN** composable 创建 EventSource 连接，state 变为 `connected`，收到的 SSE 事件触发 `onEvent` 回调，无轮询

#### Scenario: SSE 连接失败降级

- **WHEN** EventSource `onerror` 触发或 10 秒内未建立连接
- **THEN** composable 关闭 EventSource，state 变为 `fallback`，启动 `fetchFn` 每 `fallbackIntervalMs` 执行一次的定时器

#### Scenario: 浏览器不支持 EventSource

- **WHEN** EventSource 构造函数不可用
- **THEN** composable 直接进入 fallback 模式，不创建 EventSource 实例

#### Scenario: 组件卸载时清理

- **WHEN** 使用 composable 的 Vue 组件 `onUnmounted`
- **THEN** composable 关闭 EventSource 连接，清除所有 fallback 轮询定时器

### Requirement: SSE 集成 submission detail 页面

`pages/submissions/[id].vue` SHALL 集成 `useEventSource` composable，使用 SSE 优先接收状态更新，轮询作为 fallback。

- SSE 端点 URL SHALL 为 `/api/v1/submissions/${submissionId}/events`
- 收到 `submission:updated` 事件时 SHALL 更新页面数据
- 当状态变为 `finished` 或 `error` 时 SHALL 停止轮询
- 现有 `pollSubmission()` 函数 SHALL 作为 fallback 使用

#### Scenario: 提交页 SSE 实时更新

- **WHEN** 用户打开提交详情页，SSE 连接成功
- **THEN** 评测状态变更实时显示在页面上，无延迟等待

#### Scenario: 提交页 SSE 不可用时降级轮询

- **WHEN** 提交详情页 SSE 连接失败
- **THEN** 自动回退到 1500ms 间隔轮询（现有 `pollSubmission` 函数）

### Requirement: SSE 集成 queue 页面

`pages/queue.vue` SHALL 集成 `useEventSource` composable，使用 SSE 接收队列变更通知后即时刷新全量数据。

- SSE 端点 URL SHALL 为 `/api/v1/queue/events`
- 收到 `queue:changed` 事件时 SHALL 调用 `GET /api/v1/queue` 刷新全量数据
- 现有时钟计时器（1s interval）SHALL 保持不变

#### Scenario: 队列页 SSE 触发即时刷新

- **WHEN** 队列页面打开且 SSE 连接成功，新提交入队触发事件
- **THEN** 队列数据在 `queue:changed` 事件后即时刷新，无需等待轮询间隔

#### Scenario: 队列页 SSE 不可用时降级轮询

- **WHEN** 队列页面 SSE 连接失败
- **THEN** 自动回退到 2000ms 间隔轮询 `GET /api/v1/queue`
