# knowledge — 知识图谱

实例级的 AI 竞赛知识图谱：内容包（官方包 + 扩展包）的加载、校验与幂等导入，
为题目挂载知识点、节点阶梯与掌握度提供数据基础。用户文档与完整设计见
[openspec/changes/add-knowledge-graph/](../../../../openspec/changes/add-knowledge-graph/)。

| 文件               | 职责                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `index.ts`         | 唯一对外出口：`feature` 声明（含只读路由）与知识图谱能力导出                             |
| `pack.ts`          | `loadPackFromDir` / `validatePack` / `resolveOfficialPackDir`                            |
| `import.ts`        | `importPack(dir)`：单事务幂等导入，统计新增/更新/废弃节点与边                            |
| `graph.ts`         | 只读图视图 + 进程内 TTL 缓存（10 分钟）与 `invalidateKnowledgeGraphCache()`              |
| `mappings.ts`      | 题目挂载：读取、人工挂载、审核、`applyAiMapping`（AI 结果落库）、比赛保护过滤            |
| `tagging.ts`       | AI 打标：`knowledge.tag` 任务、提示词与截断、预算暂停、回填预估与管理 API 支撑           |
| `offpeak.ts`       | 低峰时段纯函数：`isWithinWindow` / `nextWindowStart`（UTC+8）、设置读取与视图            |
| `routes.ts`        | API：图谱/节点只读、题目挂载、`/admin/knowledge/reviews` 审核                            |
| `mappings.test.ts` | 服务测试（权限、校验、整体替换、AI 不覆盖人工、审核流、保护期、废弃节点）                |
| `pack.test.ts`     | 纯函数测试（临时目录构造非法包 + 真实官方包 14 领域 / 181 节点）                         |
| `import.test.ts`   | 导入测试（真实 PostgreSQL：首导、幂等、替换废弃、扩展、失败不写库）                      |
| `routes.test.ts`   | API 测试（整图/详情/开关关闭/空库/缓存失效）                                             |
| `tagging.test.ts`  | 打标测试（开关/hash/人工挂载/预算/别名未配置/重试/阈值/提示词稳定性/回填/鉴权/低峰顺延） |
| `offpeak.test.ts`  | 低峰时段纯函数测试（时段内外、跨零点、边界、下次开始、非法回退默认）                     |

## API（只读，挂在 `/api/v1`）

- `GET /knowledge/graph` →
  `{ data: { pack: { id, version } | null, areas: [{ id, name, sort }], nodes: [{ id, area, name, summary, syllabus, requires, doc }] } }`；
  只含 `active` 节点与两端 active 的 `requires`，按领域 sort、节点 sort 排序；
  无已导入包时 `pack: null`、areas/nodes 为空。
- `GET /knowledge/nodes/:id` →
  `{ data: { id, area, name, summary, syllabus, doc, requires, dependents } }`；
  不存在或已废弃 → 404。
- 两个接口采用可选鉴权（未登录可读）；`knowledge_enabled = false` 时返回 404，
  `code: "KNOWLEDGE_DISABLED"`。

## API（P1：题目挂载与审核）

- `GET /knowledge/problems/:problemId`（可选鉴权）→
  `{ data: { problem_id, state: "classified" | "unclassified", primary, secondary[], pending } }`；
  条目字段
  `node_id/name/role/source/confidence/review_status/version_id/updated_at`。
  排除 `rejected` 挂载与 `deprecated` 节点；`pending` 计入已归类并置
  `pending: true`。 题目在比赛保密保护期且查看者无编辑权限 →
  404（与「不存在」不可区分）。
- `PUT /knowledge/problems/:problemId`（鉴权 + 限流 30/min/用户）： body
  `{ primary, secondary?: string[] }`；权限 = 题目编辑权限或实例管理员；
  校验节点存在且 active、`secondary` ≤3 且不含 primary；**整体替换**为
  `source='human', review_status='confirmed'`；审计 `knowledge.mapping.update`。
- `GET /admin/knowledge/reviews?page&per_page`（实例管理员）→
  `{ data: { items: [{ problem_id, title, domain_id, primary, secondary, updated_at }], total, page, limit } }`；
  保护期题目不进队列。功能路由不经 admin 聚合中间件，路由内显式挂
  `authMiddleware` + 实例管理员检查（`isUserAdmin`，与 `adminMiddleware`
  同口径）。
- `POST /admin/knowledge/reviews/:problemId`（实例管理员 + 限流 60/min/用户）：
  body `{ decision: "accept" | "reject" }` 或 `{ primary, secondary }`。 accept
  → 该题全部 `pending` 转 `confirmed`；reject → 转 `rejected`（题目回到
  未归类，除非已有 `confirmed`/`auto` 主知识点）；修改 = 人工挂载。均写审计。
- `problemId` 形态：**题目内部 ID（`problems.id` UUID）**，与
  `/api/v1/problems/:id`、`/api/v1/admin/catalog/problems/:id` 一致；非 UUID →
  400。
- 以上接口均受 `knowledge_enabled` 约束：关闭时 404 `KNOWLEDGE_DISABLED`。

## 表（P1，`src/shared/db/schema/knowledge.ts`）

- `problem_knowledge`：`(problem_id, node_id)`
  主键；`role ∈ {primary, secondary}`、
  `source ∈ {ai, human}`、`review_status ∈ {auto, pending, confirmed, rejected}`、
  `confidence` 0–100
  可空（人工为空）、`version_id`、`updated_by`、`updated_at`；
  部分唯一索引保证每题至多一条
  `role='primary' AND review_status <> 'rejected'`。
- `knowledge_tag_runs`：AI
  打标运行记录（`status ∈ {succeeded, failed, skipped,
  budget_paused}`，`raw_output`
  jsonb，索引 `(problem_id, created_at)`）；本版本只建表， 由 `knowledge.tag`
  任务写入。

## 配置项（`src/shared/config/settings-registry.ts`，分类 `knowledge`，runtime 可热改）

| key                                 | 类型 / 默认            | 用途                                                                      |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `knowledge_enabled`                 | boolean / true         | 总开关（env 兜底 `KNOWLEDGE_ENABLED`）                                    |
| `knowledge_ai_tagging_enabled`      | boolean / false        | AI 打标开关（需网关配置别名 `platform.tagger`）                           |
| `knowledge_auto_accept_threshold`   | integer / 75（0–100）  | AI 置信度不低于此值直接生效（auto），否则进入审核（pending）              |
| `knowledge_ai_monthly_token_budget` | integer / 2000000      | 每月 token 预算（输入+输出合计，按自然月）；0 = 暂停所有调用              |
| `knowledge_ai_offpeak_only`         | boolean / true         | 仅在低峰时段调用模型（env 兜底 `KNOWLEDGE_AI_OFFPEAK_ONLY`）              |
| `knowledge_ai_offpeak_window`       | string / `00:30-08:30` | 低峰时段 `HH:MM-HH:MM`（北京时间），允许跨零点；写入按 `valueSchema` 校验 |

缓存：图数据在进程内缓存 10 分钟（已登记于
`dev-docs/engineering/domain-boundaries.md` 多副本约束表）；导入新包后同进程立即
失效，其他副本最多 10 分钟内可见。

关键约束：

- 表 `knowledge_packs` / `knowledge_areas` / `knowledge_nodes` /
  `knowledge_edges` 定义在 `src/shared/db/schema/knowledge.ts`。
- 内容包格式：`pack.yaml`（`id`、`name`、`version`、`license`、`syllabi`、 可选
  `extends: official@<version>`）+ `areas/<area>.yaml`；官方包在
  `data/knowledge-graph/`，由仓库根门禁 `scripts/check-knowledge-pack.ts` 校验。
- 节点 ID `<领域>.<名称>` 发布后不得改名或复用；删除只标记 `deprecated`。
- 扩展包（P0 仅支持扩展官方包）导入时被扩展包一并生效，ID 冲突即失败；实例
  任一时刻只有一个包 `active`。
- 导入不删除节点与边以外的历史：废弃节点保留，边按新图整体重写。

## AI 打标（P1，默认关闭）

流程（`tagging.ts`，任务类型 `knowledge.tag`，target = 题目）：

1. 总开关或 AI 打标开关关闭 → 不调用、不写记录（任务直接成功返回）。
2. 题目无已发布版本 → 不调用。
3. 内容 hash（题型、标题、题面、样例、评测模式、评测器摘要，含
   `prompt_version`）与该题最近一次 `succeeded` 相同 → `skipped`。
4. 已存在 `source='human'` 挂载 → `skipped`（AI 不覆盖人工）。
5. 低峰时段（`offpeak.ts`）：`knowledge_ai_offpeak_only` 开启且当前不在
   `knowledge_ai_offpeak_window` 内（北京时间，开始算在内、结束不算）→ **不调用
   模型、不写 `knowledge_tag_runs`**，任务 `reschedule` 到下一个时段开始。该判断
   在预算检查**之前**。
6. 本月 `queryPlatformUsage("knowledge.tag")` 的输入+输出 token ≥ 预算（或预算为
   0）→ `budget_paused`，任务 `reschedule` 到下个自然月起点。
7. 调用网关
   `platformCompletion({ purpose: "knowledge.tag", model_alias:
   "platform.tagger" })`：别名未配置
   → `skipped`；限流类错误抛出交由任务框架 退避重试；预算/配额类错误不重试（记
   `budget_paused`）。
8. 校验 JSON（primary/secondary 必须是 active 节点、secondary ≤3 且不含
   primary、confidence ∈ [0,1]）；不合法再调用一次，仍不合法 → `failed`，
   题目保持未归类。
9. 合法 → `applyAiMapping`（≥ 阈值 auto，否则 pending），记录 `succeeded`
   （tokens、model、raw_output）。

成本控制要点：

- system 消息 = 固定指令 + 全部 active 节点的 `id 名称`（**不含 summary**），
  函数内按 id 排序，同一图谱版本内逐字节稳定，置于消息最前以命中服务商提示词
  缓存；user 消息只含白名单字段（题型、标题、题面、公开样例、评测模式、
  评测器截断摘要），题面 4000 / 样例 1000 / 评测器 1000 字符，合计约 6000；
  不含隐藏测试数据与用户提交。
- `max_tokens=300`、`temperature=0`、只输出 JSON。
- **默认仅在低峰时段调用，时段可配置**：DeepSeek 在北京时间 00:30–08:30 提供
  优惠价；打标不要求实时完成，默认只在该时段调用以降低成本。发布投递与回填投递
  在时段外直接把任务的 `availableAt` 设为下一个时段开始，避免白天被反复领取再
  顺延；时段外执行时同样顺延且不写记录。
- 低峰时段的判断与投递各有一份 UTC+8 纯计算实现（`offpeak.ts` 与
  `modules/problems/services/versioning/knowledge-tag-task.ts`）：旧模块不得
  import 功能代码，设置键名即合同。
- 触发：发布新版本成功后（`problems/services/versioning/publish.ts` 事务内）投递
  任务，去重键 `tag:<versionId>`；开关关闭或草稿保存不投递。发布流程以字符串
  任务类型约定投递，不 import 本目录。

管理 API（实例管理员；`knowledge_enabled=false` 时 404）：

- `GET /admin/knowledge/tagging/usage` → 本月 input/output/total token、请求数、
  预算与剩余、`ai_tagging_enabled`、别名 `platform.tagger` 是否已配置（经网关
  `/internal/model-aliases` 列表判断；网关不可达时 `alias_configured: null`），
  以及 `offpeak: { enabled, window, next_start }`（关闭时 `next_start` 为
  null）。
- `GET /admin/knowledge/tagging/estimate` → 待回填题数（已发布、无人工挂载、
  最新内容未成功打标）、固定前缀长度 + 平均题目长度 × `ESTIMATE_TOKENS_PER_CHAR`
  （0.7，估算系数）+ 输出上限的 token 估算；网关未暴露单价，`estimated_cost` 为
  null；另含
  `offpeak: { enabled, window, next_start }`（回填任务同样在低峰时段执行）。
- `POST /admin/knowledge/tagging/backfill`（限流 3/min/用户）：body 须带
  `confirm: true` 与预估返回的 `expected_count`；实际数偏差超过 10% → 409
  要求重新预估；保护期题目不投递；按题目去重投递，写审计。

测试：`cd noj-core && deno task test:domain knowledge`；发布投递用例在
`modules/problems/tests/services/knowledge-tag-task.test.ts`（`test:domain problems`）。
