## Why

LMCC 青少年组要求“运行已经写好的 Python 代码”，对标 HydroOJ 的自测（pretest）是刷题体验标配：提交前先验证代码能否通过完整评测。当前 NOJ 只有正式提交，用户无法在不污染评测历史/统计/榜单的前提下先跑一次完整评测。

## What Changes

- 新增“代码自测”能力：用户从编辑器发起自测，**与正式评测走完全相同的双容器评测流程**（Evaluator + Solution + evaluate.py），但结果**不计入正式提交记录、统计、榜单、AC 活动**。
- 新增独立 `self_tests` 表（长期保留），与 `submissions` / `evaluationResults` 完全隔离。
- 新增自测 API：
  - `POST /api/v1/problems/:id/self-test` — 创建自测并推入评测队列
  - `GET /api/v1/self-tests/:id` — 查询自测状态/分数/输出
- 评测消费者通过自测 ID 前缀 `st_` 路由结果到 `saveSelfTestResult`，**noj-judge 层零改动**。
- 前端编辑器新增“自测”按钮与侧栏“自测”Tab，展示状态/分数/输出，通过轮询获取结果。
- 自测任务与正式任务共用 Redis 评测队列；队列页展示自测条目并标记为自测。
- 新增独立更严格的自测限流（IP + 用户双维度，默认每用户 60s 4 次），防止滥用评测资源。
- 第一版**不做任意自定义输入**，自测即完整评测；不开放竞赛模式。

## Capabilities

### New Capabilities

- `code-self-test`: 代码自测的完整能力——独立数据模型、创建/查询 API、评测结果路由、前端自测交互、限流与队列可见性。

### Modified Capabilities

- `database-schema`: 新增 `self_tests` 表（用户/题目/语言/代码/状态/分数/输出/详情/时间戳）。
- `queue-overview`: 队列概览 API 与页面需要展示自测任务，并标记条目类型为 `self_test`。

## Impact

- **noj-core**：新增 `src/db/schema.ts` 表定义与 Drizzle 迁移；新增 `src/services/self-tests.ts`、`src/routes/self-tests.ts`；修改 `src/mq/consumer.ts`（自测结果路由）、`src/mq/sweeper.ts`（自测 pending 恢复）、`src/services/queue.ts`（队列概览包含自测）、`src/lib/hardening-rate-limit.ts`（自测限流）、`src/app.ts`（挂载路由）。
- **noj-ui**：修改 `EditorWorkspace` / `EditorToolbar` / `EditorSidebar`，新增自测按钮与自测结果 Tab；新增 `composables/useSelfTestPolling.ts`。
- **noj-tests**：新增自测 E2E，覆盖“自测返回分数/状态/输出”和“自测后历史/统计/榜单不变”。
- **API**：新增 `/api/v1/problems/:id/self-test` 与 `/api/v1/self-tests/:id`。
- **依赖**：无新增外部依赖；noj-judge 无改动。
