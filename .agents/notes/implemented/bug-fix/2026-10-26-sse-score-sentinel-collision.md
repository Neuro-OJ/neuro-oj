# Agent Note: 稳定教学 SSE 隐私哨兵

Status: implemented

## Problem

教学通知与进度 SSE 验收用 `9999`/`12345` 作为“不应泄露的 score”哨兵。测试同时把持久化 SSE 自增 ID 写入响应的 `id` 字段；在共享隔离数据库中，事件 ID 可能恰好包含同一数字，导致测试把合法的 SSE ID 误判为泄露的 score。

## Decision

两条教学 SSE 隐私测试统一使用 `Number.MAX_SAFE_INTEGER` 作为 score 哨兵，并在断言中显式转换为字符串。哨兵仍以 JSON 数值进入事件，保持真实 payload 形状，同时与实际事件序列 ID 保持可验证的数量级差异。

## Alternatives considered

- 保留小整数并依赖每次测试前重置 `sse_events` sequence：没有解决真实并行/共享数据库中的序列漂移，还会增加测试对重置实现的耦合。
- 改用非数值字符串：能避免碰撞，但不再覆盖真实 score 数值字段的序列化路径。

## Consequences

- 测试只会把真实的 score 泄露误报为失败，不会因 SSE 元数据 ID 偶然相同而产生伪失败。
- 该改动只调整验收夹具，不改变生产 SSE payload、授权过滤或跨域路由行为。
