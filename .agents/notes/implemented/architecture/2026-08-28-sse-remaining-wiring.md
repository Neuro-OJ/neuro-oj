# Agent Note: SSE 剩余项完成（contest 重放 + 提交页 SSE）

Status: implemented

## Problem

P2.3 主体接入后，contest 频道还没有重放，提交详情页仍依赖纯轮询。

## Decision

- contest SSE 端点支持 `Last-Event-ID` / `afterSeq` 重放：
  - submission 事件按原样透传（非 admin 隐藏 `user_id`）。
  - ranking 事件触发 `pushRanking` 拉取最新榜单。
- `useSubmissionPolling` 改为“SSE 优先 + fallback 轮询”：
  - 通过 `useEventSource` 订阅 `/api/v1/submissions/:id/events`。
  - SSE 不可用时自动降级到 1.5s 轮询。
  - 终态自动停止。

## Alternatives considered

- 保留纯轮询：延迟高、浪费请求。
- 在 EditorWorkspace 手动组合 SSE：逻辑分散，不如收敛到 composable。

## Consequences

- 提交详情页实时性提升，且保留轮询兜底。
- contest 重放补全，所有主要 SSE 频道均支持续传。
