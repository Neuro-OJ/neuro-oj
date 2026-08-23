## Context

评测任务在 Redis `noj:judge:queue` 列表中等待 Worker 以原始 JSON 字符串领取。正式提交入队后状态为 `judging`，因此仅修改数据库状态无法阻止后续评测；仅删除 Redis 任务又会使提交长期显示为评测中。

## Goals / Non-Goals

**Goals:**

- 让管理员移除单个仍位于 pending list 的正式提交任务。
- 保留提交和代码，仅结束其等待状态。
- 记录可追溯审计日志，并使队列页面实时刷新。

**Non-Goals:**

- 不终止已被 Worker 领取并正在执行的评测。
- 不删除 self-test 任务，也不提供批量清空队列。
- 不修改评测 Worker 的消费协议。

## Decisions

1. 管理端通过 `DELETE /api/v1/admin/queue/submissions/:id` 发起操作。该路由已位于管理员中间件之后，普通用户无法调用。
2. 服务读取 pending list，按 `submission_id` 找到原始任务 JSON，再使用 `LREM key 1 raw` 删除精确条目。若 `LREM` 返回 0，说明任务已被 Worker 领取或已删除，返回 404 且不改数据库。
3. 成功删除后，将对应仍处于 `judging` 的提交更新为 `error` 并写入 `judge_finished_at`。提交记录和已有评测结果保持不变。
4. 成功操作写入 `submissions.queue_removed` 审计记录，随后发布 `queue:changed` SSE 事件。
5. 管理后台仅在 `judging` 提交上显示“移出队列”；接口返回 404 时提示任务已不在等待队列并刷新列表。

## Risks / Trade-offs

- Redis 扫描与 `LREM` 不是单一命令，但精确 `LREM` 的返回值作为最终条件：Worker 先领取时删除不会成功，避免误结束正在执行的任务。
- 队列中若存在陈旧的重复任务，操作仅移除最先匹配的一个任务，符合单任务删除语义。
