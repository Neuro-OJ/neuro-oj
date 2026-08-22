## Why

当评测 Worker 异常、任务格式错误或队列积压时，管理员目前无法移除单个待处理任务，只能等待 Worker 消费或直接操作 Redis。需要提供可审计的管理能力，避免提交长期停留在“评测中”。

## What Changes

- 新增仅管理员可调用的待处理评测任务移除接口。
- 成功移除 Redis 中的待处理任务后，将对应正式提交标记为 `error`，但不删除提交及历史数据。
- 为该管理操作新增审计 action，并通知队列订阅者刷新。
- 在管理后台提交列表中为排队中的提交提供二次确认的“移出队列”操作。

## Capabilities

### New Capabilities

- `admin-queue-management`: 管理员安全移除尚未被评测 Worker 领取的正式提交任务。

### Modified Capabilities

- `admin-submission-management`: 提交管理页面提供待处理任务移除操作。
- `audit-log`: 审计日志记录评测队列任务移除操作。

## Impact

- 后端队列服务、管理端提交路由、审计日志类型与数据库约束。
- 管理后台 `/admin/submissions` 页面。
- Redis pending list、PostgreSQL 提交状态和 SSE 队列变更事件。
