## Purpose

定义前端 SSE 集成与自动轮询降级策略的规范，包括 `useEventSource` composable 及其在提交详情页和队列页面的集成。

## Requirements

### Requirement: useEventSource Composable

系统 SHALL 提供 `useEventSource` composable，集成 EventSource API 与自动轮询 fallback。

- composable SHALL 接受 `url`（SSE 端点）、`onEvent`（事件回调）、`fetchFn`（fallback 函数）、`fallbackIntervalMs`（fallback 间隔）参数
- composable SHALL 额外支持 `enabled`（启用/禁用 ref）、`onMessage`（通用消息回调）参数
- composable SHALL 暴露 `state` ref（`"connecting" | "connected" | "fallback" | "disabled"`）
- 当 SSE 连接成功时 SHALL 停止 fallback 轮询
- 当 SSE 连接失败/断开时 SHALL 自动降级到 fallback 轮询
- 降级到 fallback 后 SHALL 每 30 秒尝试重连一次 SSE
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

#### Scenario: Fallback 模式下重试 SSE

- **WHEN** state 为 `fallback` 且过了 30 秒
- **THEN** composable 尝试重建 EventSource 连接；成功则切换到 `connected`，失败继续保持 `fallback`

### Requirement: SSE 集成 submission detail 页面

`pages/submissions/[id].vue` SHALL 集成 `useEventSource` composable，使用 SSE 优先接收状态更新，轮询作为 fallback。

- SSE 端点 URL SHALL 为 `/api/v1/submissions/${submissionId}/events`
- 收到 `submission:updated` 事件时 SHALL 调用 `pollSubmission()` 通过 REST 拉取全量提交数据
- 当 `pollSubmission()` 检测到状态变为 `finished` 或 `error` 时 SHALL 设置 `sseEnabled = false` 停止 SSE 连接
- 现有 `pollSubmission()` 函数 SHALL 同时作为 fallback `fetchFn` 使用

#### Scenario: 提交页 SSE 实时更新

- **WHEN** 用户打开提交详情页，SSE 连接成功
- **THEN** 评测状态变更通过 SSE 触发 `pollSubmission()` 即时调用，页面数据显示最新状态

#### Scenario: 提交页 SSE 不可用时降级轮询

- **WHEN** 提交详情页 SSE 连接失败
- **THEN** 自动回退到 1500ms 间隔轮询 `pollSubmission()`

#### Scenario: 提交终态后停止 SSE

- **WHEN** `pollSubmission()` 检测到提交状态为 `finished` 或 `error`
- **THEN** `sseEnabled` 置为 false，SSE 连接关闭，所有轮询停止

### Requirement: SSE 集成 queue 页面

`pages/queue.vue` SHALL 集成 `useEventSource` composable，使用 SSE 接收队列变更通知后即时刷新全量数据。

- SSE 端点 URL SHALL 为 `/api/v1/queue/events`
- 收到 `queue:changed` 事件时 SHALL 调用 `GET /api/v1/queue` 刷新全量数据
- SSE 不可用时 SHALL 降级到 2000ms 间隔轮询 `GET /api/v1/queue`

#### Scenario: 队列页 SSE 触发即时刷新

- **WHEN** 队列页面打开且 SSE 连接成功，新提交入队触发事件
- **THEN** 队列数据在 `queue:changed` 事件后即时刷新，无需等待轮询间隔

#### Scenario: 队列页 SSE 不可用时降级轮询

- **WHEN** 队列页面 SSE 连接失败
- **THEN** 自动回退到 2000ms 间隔轮询 `GET /api/v1/queue`
