# Agent Note: 事件域分离文档

Status: implemented

## Problem

SSE / Redis Pub/Sub 与 DB 状态之间的边界没有明确文档，容易在实现中产生“第二份状态真相”。

## Decision

新增 `docs/engineering/event-domains.md`，明确：

- DB / 事件日志是事实源。
- Redis Pub/Sub / SSE 是实时投影。
- 客户端以 REST 为最终校准源。
- 状态变更必须先写 DB 再发布通知。

## Alternatives considered

- 立即重构 event-bus 为事件日志：依赖 Phase 2.3 的 `sse_events` 表，先以文档固定原则。
- 不写文档：边界继续靠口头约定。

## Consequences

- 后续 SSE 事件日志改造有明确设计依据。
- 新功能开发时能快速判断状态应写 DB 还是只发 SSE。
