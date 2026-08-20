## Context

NOJ 当前正式提交链路为：`POST /api/v1/submissions` → 写 `submissions` + `evaluationResults` → `pushJudgeTask` → noj-judge 双容器评测 → 结果消费者写回并更新统计/榜单/AC 活动。用户没有“不污染正式记录的先跑一次完整评测”的能力。

Issue #221 要求支持代码自测：与正式评测走完全相同的评测路径（Evaluator + Solution + evaluate.py），但结果不计入正式评测记录。LMCC 场景下自测也需要看到分数，因此不采用 HydroOJ 的 run-only 模式。

## Goals / Non-Goals

**Goals:**

- 提供 `POST /api/v1/problems/:id/self-test` 与 `GET /api/v1/self-tests/:id`。
- 自测结果独立存储在 `self_tests` 表，长期保留，不影响 `submissions` / `evaluationResults` / 统计 / 榜单 / AC 活动。
- 复用现有评测队列与 noj-judge，**noj-judge 零改动**。
- 前端编辑器提供“自测”按钮与侧栏“自测”Tab，通过轮询展示结果。
- 队列页展示自测任务并标记。
- 自测限流比正式提交更严格。

**Non-Goals:**

- 不做任意自定义输入/run-only 模式（第一版自测 = 完整评测）。
- 不开放竞赛模式自测。
- 不做自测历史列表页（数据长期保留，但 UI 第一版不提供）。
- 不修改 noj-judge 的 MQ 协议、沙箱、评测逻辑。

## Decisions

### D1. 独立 `self_tests` 表，而非在 `submissions` 上加标记

- **选择**：新增单表 `self_tests`，字段包含状态/分数/输出/详情/时间戳。
- **理由**：与正式提交完全隔离，所有统计/榜单/AC 查询天然不受影响；避免在既有 `submissions` 查询中到处加 `is_self_test` 过滤。
- **备选**：在 `submissions` 加 `kind` 或 `is_self_test` 列——会污染所有正式查询与索引，且历史语义不清。

### D2. 自测 ID 使用 `st_` 前缀，消费者按前缀路由

- **选择**：`self_tests.id = "st_" + uuid`，`JudgeTask.submission_id` 直接使用该 ID；`mq/consumer.ts` 检测 `submission_id.startsWith("st_")` 后调用 `saveSelfTestResult`。
- **理由**：noj-judge 将 `submission_id` 视为不透明字符串，不需要改 Rust 代码；core 侧无需新增 MQ 队列或消息字段。
- **备选**：新增 `JudgeTask.kind` 字段或独立结果队列——前者需要 judge 感知/透传，后者需要额外消费者或队列配置，均偏离“judge 零改动”。

区分链路：

1. **ID 生成时区分**：正式提交 `submission_id = crypto.randomUUID()`；自测 `self_test_id = "st_" + crypto.randomUUID()`。
2. **评测队列 / noj-judge 层不区分**：`JudgeTask.submission_id` 与 `JudgeResult.submission_id` 对 judge 而言只是不透明字符串，原样透传，因此 judge 零改动。
3. **core 消费者按前缀区分**：收到结果后，`submission_id.startsWith("st_")` 为真时走 `saveSelfTestResult`，否则走正式 `saveEvaluationResult`。
4. **队列页按前缀区分**：从 Redis 队列拿到 ID 后，`st_` 开头查 `self_tests` 并标记 `kind: "self_test"`，否则查 `submissions` 并标记为正式提交。

不引入 `JudgeTask.kind` 的原因：judge 结果里不会自动带回该字段，core 仍无法从结果区分；而 ID 前缀在创建、队列、结果、查询全链路天然可见，实现成本最低。

### D3. 自测结果写回独立幂等逻辑

- **选择**：`saveSelfTestResult` 只更新 `self_tests` 表，不做 `applyNewResult` / `refreshRankingsView` / `createActivity`；已终态的自测结果直接忽略。
- **理由**：自测不参与任何正式统计；幂等处理避免重复结果覆盖。
- **备选**：复用 `saveEvaluationResult` 加分支——耦合正式提交的状态机与统计副作用，风险高。

### D4. 复用同一 Redis 队列，队列页展示自测条目

- **选择**：自测任务 `pushJudgeTask` 到现有 `noj:judge:queue`；`services/queue.ts` 的 pending/judging 查询同时从 `self_tests` 解析 `st_` 开头的 ID，并给条目增加 `kind: "self_test"` 标记。
- **理由**：不改 judge 队列消费；队列页计数一致，用户可看到自测排队。
- **备选**：独立队列或队列页隐藏自测——前者需要额外 judge 实例/队列配置，后者会造成 `pending_count` 与展示不一致。

### D5. 自测 API 与轮询

- **选择**：`POST /api/v1/problems/:id/self-test` 返回 `201 { id, status: "judging", ... }`；前端轮询 `GET /api/v1/self-tests/:id`。
- **理由**：与现有正式提交体验一致，避免同步长连接；实现简单可靠。
- **备选**：SSE 推送——需要新增自测事件通道，第一版不必要。

### D6. 自测限流独立且更严格

- **选择**：在 `hardening-rate-limit.ts` 新增 `SELF_TEST_IP_LIMIT` / `SELF_TEST_USER_LIMIT`；默认每用户 60 秒窗口 4 次，IP 维度保留一个较宽的防滥用上限（如 60 秒 30 次），创建自测时 IP + 用户双维度限流。
- **理由**：自测消耗评测容器资源但无正式记录，需要防滥用。
- **备选**：复用正式提交限流——无法体现自测更高的资源成本。

### D7. 自测 pending 恢复

- **选择**：`mq/sweeper.ts` 增加 `recoverPendingSelfTests()`，扫描 `self_tests` 中超过 2 分钟的 pending，重新入队或标记 error。
- **理由**：自测与正式任务共用队列，core 在“写表 → 入队”之间崩溃时不能留下永久 pending。
- **备选**：不恢复——自测非关键，但会残留脏数据且用户看到永久 pending。

### D8. 前端交互

- **选择**：`EditorWorkspace` 增加 `selfTest` prop（仅普通题库传入）；工具栏增加“自测”按钮；侧栏新增“自测”Tab，展示状态/分数/输出。
- **理由**：复用现有编辑器布局，改动最小；竞赛模式不传 prop 即隐藏。
- **备选**：题目详情页加入口——第一版不做，避免扩大改动面。

## Risks / Trade-offs

- [自测与正式任务共用队列，自测可能挤占正式评测资源] → 独立限流 + 队列本身有长度上限；后续可考虑自测优先级/单独队列。
- [`st_` 前缀依赖字符串约定] → 在 core 内定义为常量，并确保正式提交 ID 仍为 UUID；消费者按前缀路由有单测覆盖。
- [队列页新增 `kind` 字段影响前端类型/展示] → 前端按 `kind === "self_test"` 显示“自测”标记，向后兼容缺省视为正式提交。
- [自测表长期保留导致数据增长] → 已确认长期保留；后续如需要可增加清理任务，不阻塞本变更。
- [自测结果页/队列页可能泄露他人自测] → `GET /self-tests/:id` 仅 owner/admin 可读；队列页只显示用户名/题目/ID 等非敏感信息。

## Migration Plan

1. `deno task db:generate` 生成 `self_tests` 表迁移；`deno task db:migrate` 应用。
2. 发布 noj-core：新表、自测 service/route、消费者路由、sweeper、queue 展示、限流。
3. 发布 noj-ui：编辑器自测按钮/Tab、轮询 composable。
4. 发布 noj-tests：自测 E2E。
5. 回滚策略：新表不影响现有功能；代码回滚后删除新迁移即可（未上线数据时）。

## Open Questions

无。
