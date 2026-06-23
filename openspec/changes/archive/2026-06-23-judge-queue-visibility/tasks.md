## 1. 数据库迁移

- [x] 1.1 创建 Drizzle 迁移文件，在 `submissions` 表增加 `judge_started_at` 和 `judge_finished_at` 列（均为 `text` 可空，ISO 8601 时间戳）
- [x] 1.2 更新 `services/submissions.ts` 中的状态流转逻辑：设置 `judging` 状态时同步写入 `judge_started_at`，设置 `finished`/`error` 时同步写入 `judge_finished_at`

## 2. 后端队列查询服务

- [x] 2.1 新建 `services/queue.ts`，实现队列状态查询逻辑：
  - `getPendingJobs()`: 使用 `LRANGE noj:judge:queue 0 -1` 获取等待中的 job，解析 `submission_id`，LEFT JOIN `users` 表获取 `username`（作为 `submitted_by`），LEFT JOIN `problems` 获取 `problem_title`
  - `getJudgingJobs(pendingIds: string[])`: 查询 DB `status = "judging"` 并排除 pending 列表中的 ID
  - `getRecentlyCompleted()`: 查询 DB `status IN ("finished", "error")`，JOIN `evaluation_results`，取最近 10 条按完成时间降序
  - `getQueueStats()`: 返回 pending 数、judging 数、当日完成数
  - `getQueuePosition(submissionId: string)`: 在 `LRANGE` 结果中查找索引 +1
- [x] 2.2 在 `services/queue.ts` 中导出响应 TypeScript 接口 `QueueResponse`、`QueueItem`、`QueueStats`

## 3. 后端 API: `GET /api/v1/queue`

- [x] 3.1 新建 `routes/queue.ts`，实现 `GET /api/v1/queue` 端点（无需认证）
- [x] 3.2 在 `app.ts` 中注册路由：`app.route("/api/v1/queue", queue)`

## 4. 后端 API: `GET /api/v1/submissions/:id/status` 及详情增强

- [x] 4.1 在 `routes/submissions.ts` 中新增 `GET /:id/status` 端点（需 JWT 认证，不限制提交者身份）
- [x] 4.2 在 `services/queue.ts` 中新增 `getSubmissionQueueStatus(id)` 函数，返回状态 + 排队位置 + 时间戳
- [x] 4.3 增强 `services/submissions.ts` 中 `getSubmission()` 的返回类型，增加 `queue_position`、`queue_length`、`judge_started_at`、`judge_finished_at` 字段

## 5. 后端测试

- [x] 5.1 为 `services/queue.ts` 编写单元测试（mock Redis `LRANGE` 和 `LLEN`）
- [x] 5.2 为 `GET /api/v1/queue` 编写集成测试（未认证访问、队列为空、含任务的响应格式）
- [x] 5.3 为 `GET /api/v1/submissions/:id/status` 编写集成测试（未认证 401、存在/不存在的提交、排队中/judging/finished 状态）

## 6. 前端轮询 composable

- [x] 6.1 新建 `composables/usePolling.ts`，通用轮询组合函数，支持自定义间隔、条件自动停止（如状态变为终态时）、清理

## 7. 前端全局队列页面 `/queue`

- [x] 7.1 新建 `pages/queue.vue`，调用 `GET /api/v1/queue` 获取数据
- [x] 7.2 实现三区域布局：正在评测（按 `judge_started_at` 降序）、排队中（按 `submitted_at` 降序）、最近完成（按 `judge_finished_at` 降序）
- [x] 7.3 每个区域显示行/卡片：提交 ID（截断前 8 位）、题目编号和标题、语言标签、提交者用户名、提交时间
- [x] 7.4 正在评测的项目额外显示「开始时间 + 已持续 X 秒」
- [x] 7.5 已完成项目显示得分（0 分用红色标示）
- [x] 7.6 使用 `usePolling` 每 2 秒自动刷新

## 8. 前端提交结果页增强 `submissions/[id].vue`

- [x] 8.1 增加排队位置信息展示：`queue_position / queue_length`（status 为 pending 时）
- [x] 8.2 增加「开始评测时间」展示（status 为 judging 时）
- [x] 8.3 将轮询间隔从 1s 改为 0.5s
- [x] 8.4 在 pending/judging 状态下展示对应的动画/加载状态

## 9. 端到端验证

- [x] 9.1 启动完整服务（Redis + noj-core + noj-ui），确认 `/api/v1/queue` 返回正确结构
- [x] 9.2 提交一道题目，确认 `/api/v1/queue` 中 pending/judging 列表实时更新
- [x] 9.3 确认 `/queue` 页面三区域正确渲染并自动刷新
- [x] 9.4 确认 `submissions/[id]` 页面在排队→评测→完成全流程中正确展示过渡状态
