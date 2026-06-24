## Context

用户提交代码后，系统目前无法提供评测进度的可见性。用户无法得知提交是在排队中、正在被评测还是已完成。现有架构中，noj-core 通过 Redis 列表（LPUSH/BRPOP）向 noj-judge 分发评测任务，但队列的内部状态未通过 API 暴露给前端。

当前评测流程：
1. `createSubmission` 插入 DB（`status: "pending"`）→ LPUSH 到 Redis 队列 → 立即更新 DB `status: "judging"`
2. noj-judge 通过 BRPOP 拉取任务 → 执行评测 → LPUSH 结果到 `noj:judge:results`
3. 消费者从 `noj:judge:results` BRPOP 结果 → 持久化 → 更新 DB `status: "finished"` / `"error"`

由于 DB 中 `status` 在入队后即设为 `"judging"`，无法单独通过 DB 区分「排队中」和「评测中」，需要结合 Redis 队列内容来判断。

## Goals / Non-Goals

**Goals:**
- 提供公共的全局队列状态 API（`GET /api/v1/queue`），返回 pending、judging、recently_completed 三区列表及统计
- 提供认证的单个提交状态 API（`GET /api/v1/submissions/:id/status`），返回排队位置和状态
- 增强现有 `GET /api/v1/submissions/:id` 响应，增加状态相关字段
- 前端实现 `/queue` 全局队列页面和提交结果页的过渡状态展示
- 访客可查看全局队列概览，任意已登录用户可查任意提交的排队状态

**Non-Goals:**
- 不改变评测流程本身（不涉及 noj-judge 改造）
- 不实现 WebSocket 推送（使用轮询）
- 不改变代码访问权限（提交者权限以 Issue #52 为准）
- 不改变 admin 管理端队列管理功能
- 不实现队列深度/优先级的控制

## Decisions

### 1. 队列状态判定策略

通过结合 Redis 队列内容和数据库状态来区分排队中和评测中：

| 状态 | 判定方式 |
|------|---------|
| **pending** | 从 Redis `noj:judge:queue` 通过 `LRANGE 0 -1` 获取所有等待中的 job，解析 `submission_id` 列表，再查询数据库补充元数据 |
| **judging** | 查询数据库 `status = "judging"`，排除在 pending 列表中的 ID，剩余即为正在评测的 |
| **recently_completed** | 查询数据库 `status IN ("finished", "error")`，按 `judge_finished_at`（即 `updated_at`）降序，取最近 10 条 |

**为什么不是 BullMQ：** 本项目的 Redis 用法是直接 LPUSH/BRPOP，未使用 BullMQ。因此通过 `LRANGE` 获取队列内容。

**为什么 pending 列表直接用 LRANGE 而非独立维护：** 现有的 `noj:judge:queue` 就是唯一的待评测队列，`LRANGE 0 -1` 可直接获取所有等待中任务，避免了额外的数据同步。

### 2. 队列位置计算

- 通过 `LRANGE noj:judge:queue 0 -1` 获取的数组中查找目标 `submission_id` 的索引，+1 得到 1-based 排队位置
- 已进入 judging（不在队列中）时返回 `null`
- `queue_length` 通过 `LLEN noj:judge:queue` 获取

**性能注意：** 大队列下 `LRANGE 0 -1` 全量获取可能较慢。V1 先保持简单，后续可通过跟踪每个 job 的入队时间戳（Redis ZSET）优化位置查询。

### 3. 轮询间隔

| 页面 | 间隔 | 理由 |
|------|------|------|
| `/queue` 全局队列页 | 2 秒 | 排队/评测信息变化频率中等，2s 平衡实时性和负载 |
| `submissions/[id].vue` 结果页 | 0.5 秒 | 用户在自己的提交页上期望尽快看到结果，0.5s 低延迟感知 |

**替代方案考虑：** WebSocket/SSE 可实现实时推送但增加架构复杂度（需维护连接池、认证状态）。轮询方案实现简单，对当前系统改动最小。

### 4. 最近完成记录的数据来源

优先使用数据库查询（`submissions` JOIN `evaluation_results`），而非依赖 Redis 中的近期消息。Redis 中的结果消息在消费后即被移除，不适合作为历史查询来源。数据库是权威数据源。

### 5. 权限模型分离

- `GET /api/v1/queue`：无须认证，挂载在公共路由上
- `GET /api/v1/submissions/:id/status`：需要 JWT 认证，使用现有 `authMiddleware`
- `GET /api/v1/submissions/:id` 增强字段：需要 JWT 认证，维持现有中间件

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|---------|
| `LRANGE 0 -1` 全量获取队列，大队列下性能慢 | V1 先保持简单；后续可通过 Redis 有序集合（ZSET）跟踪每个 job 的入队时间、用 ZRANK 计算排名 |
| 判定 judging 需排除 pending 列表，涉及两次查询 | pending 和 judging 共享一次 `LRANGE` 结果，避免重复 |
| 数据库 `judging` 状态与 Redis 队列状态短暂不一致 | 以 Redis + DB 组合判断为准；前端说明"数据可能存在短暂延迟" |
| 频繁轮询（0.5s）增加提交详情 API 负载 | 前端在状态变为 completed/error 后立即停止轮询；可考虑后续加入指数退避 |
