# Agent Note: SSE 事件日志全量接入

Status: implemented

## Problem

SSE 事件日志只有表与辅助函数，尚未接入实际事件发布与重放。

## Decision

完成全量接入：

- 将 noj-core 所有服务层 `publishEvent` 调用替换为 `publishSseEvent`（写 `sse_events` 表 + Redis 发布 + seq）。
- SSE 路由支持 `Last-Event-ID` / `afterSeq`，在连接建立后重放缺失事件，并为重放事件写入 SSE `id`。
- 覆盖频道：submission、queue、stats、user（notification）。
- 前端 `useEventSource` 新增 `lastEventId`，重连时通过 `afterSeq` 参数请求重放，并按 `seq` 更新游标。

## Alternatives considered

- 仅替换发布不加重放：仍会丢事件。
- 前端手动存 Last-Event-ID 到 localStorage：EventSource 原生 `id` 已足够，无需持久化。

## Consequences

- SSE 事件具备持久化、重放、断线续传能力。
- contest 频道重放尚未接入，后续补充。
- 需要数据库迁移（`0057_magenta_lenny_balinger.sql`）后服务才能写 `sse_events`。
