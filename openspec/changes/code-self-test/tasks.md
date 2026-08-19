## 1. 数据模型与类型

- [x] 1.1 在 `noj-core/src/db/schema.ts` 新增 `self_tests` 表定义（字段见 database-schema spec，含 user_id/problem_id/created_at 索引）
- [x] 1.2 运行 `deno task db:generate` 生成 Drizzle 迁移，并 `deno task db:migrate` 应用
- [x] 1.3 新建 `noj-core/src/types/self-tests.ts`，定义 `SelfTestStatus`、`SelfTestInput`、`SelfTestResponse`、`SelfTestDetail`
- [x] 1.4 定义自测 ID 前缀常量（如 `SELF_TEST_ID_PREFIX = "st_"`），并在正式提交 ID 生成处保持 UUID 不冲突

## 2. 后端 Service

- [x] 2.1 实现 `services/self-tests.ts` 的 `createSelfTest(userId, problemId, input)`：校验题目/语言/runtime_config/镜像，写入 `self_tests`，`pushJudgeTask` 后更新为 judging
- [x] 2.2 实现 `getSelfTest(id, viewerId, viewerRole, c)`：仅 owner/admin 可读，output 按 8KB 截断，details 解析 JSON
- [x] 2.3 实现 `saveSelfTestResult(result)`：幂等写回 `self_tests`，不触发统计/榜单/AC 活动
- [x] 2.4 编写并跑通 `tests/services/self-tests.test.ts`（创建成功/题目不存在/语言不支持/队列失败/结果幂等/权限）

## 3. 自测限流

- [x] 3.1 在 `lib/hardening-rate-limit.ts` 新增 `SELF_TEST_IP_LIMIT` / `SELF_TEST_USER_LIMIT`（默认每用户 60s / 4 次；IP 维度保留较宽上限）
- [x] 3.2 实现 `enforceSelfTestRateLimit(c, userId)` 并在创建自测路由调用
- [x] 3.3 编写限流测试（超阈值返回 429，Redis 不可用 fail-closed）

## 4. 后端 API 与路由

- [x] 4.1 新建 `routes/self-tests.ts`：`POST /api/v1/problems/:id/self-test` 与 `GET /api/v1/self-tests/:id`
- [x] 4.2 抽取/复用题目双索引解析 `resolveProblem`（当前位于 `routes/problems.ts` 内部），供自测路由使用
- [x] 4.3 在 `app.ts` 挂载自测路由
- [x] 4.4 编写并跑通 `tests/routes/self-tests.test.ts`（401/404/400/429/权限/正常创建与查询）

## 5. MQ 消费者与 sweeper

- [x] 5.1 修改 `mq/consumer.ts`：`submission_id` 以 `st_` 开头时调用 `saveSelfTestResult`，否则走正式 `saveEvaluationResult`
- [x] 5.2 修改 `mq/sweeper.ts`：新增 `recoverPendingSelfTests()`，扫描 `self_tests` 中超过 2 分钟的 pending 重新入队或标记 error
- [x] 5.3 编写消费者/sweeper 相关测试（前缀路由、重复结果幂等、pending 恢复）

## 6. 队列概览

- [x] 6.1 修改 `services/queue.ts`：pending/judging/recently_completed 同时从 `self_tests` 解析 `st_` 开头 ID，并返回 `kind`
- [x] 6.2 更新 `GET /api/v1/queue` 相关测试：自测条目带 `kind: "self_test"`，统计包含自测
- [x] 6.3 更新前端队列页类型与展示：`kind === "self_test"` 时显示“自测”标记

## 7. 前端

- [x] 7.1 新增 `composables/useSelfTestPolling.ts`（可参考 `useSubmissionPolling`）
- [x] 7.2 修改 `EditorWorkspace`：新增 `selfTest` prop、自测状态与轮询逻辑、侧栏“自测”Tab
- [x] 7.3 修改 `EditorToolbar`：新增“自测”按钮（仅传入 `selfTest` 时显示）
- [x] 7.4 修改 `EditorSidebar`：新增“自测”Tab 内容（状态/分数/输出）
- [x] 7.5 修改 `pages/editor/[id].vue`：普通题库传入 `selfTest`，竞赛模式不传
- [x] 7.6 运行 `deno lint` / `deno fmt` / `nuxt build`

## 8. E2E 与收尾

- [x] 8.1 新建 `noj-tests/e2e/self-test.test.ts`：创建自测、轮询到终态、返回分数/状态/输出
- [x] 8.2 E2E 断言自测后提交历史/统计/榜单/AC 活动不变化
- [x] 8.3 E2E 断言队列页展示自测条目且标记正确
- [x] 8.4 运行 noj-core 全量测试、noj-ui 构建、noj-tests 全量 E2E
- [x] 8.5 确认 OpenSpec 变更（proposal/design/specs/tasks）齐全且可归档
