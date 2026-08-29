# Agent Note: SSE 事件日志基础

Status: implemented

## Problem

SSE 使用 Redis Pub/Sub fire-and-forget，事件不持久、不可重放；且 Drizzle 迁移链存在 0054/0055 分叉导致 `db:generate` 失败。

## Decision

- 修复 `drizzle/meta/0055_snapshot.json` 的 `prevId`，使其指向 `0054` 的 id，恢复线性迁移链。
- 新增 `sse_events` 表（全局 `serial id`、`channel`、`payload jsonb`、`created_at`），并生成 `0057_magenta_lenny_balinger.sql`。
- 新增 `src/lib/sse-events.ts`：`recordSseEvent` / `replaySseEvents`。
- 新增 `publishSseEvent`：写库后发布 Redis，payload 附带 `seq`。

## Alternatives considered

- 直接手工改 `_journal.json`：不需要，修复 snapshot `prevId` 即可。
- 为每个频道单独建表：增加复杂度，统一 `sse_events` 表更简单。

## Consequences

- `deno task db:generate` 恢复正常。
- SSE 事件具备持久化与重放基础。
- 后续需将现有 `publishEvent` 调用逐步切换到 `publishSseEvent`，并让 SSE 路由支持 `Last-Event-ID` 重放。
