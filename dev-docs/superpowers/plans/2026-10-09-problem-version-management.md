# 题目版本管理实施计划与进度

> 依据：《Neuro OJ 题目版本管理实施 Handbook》（本次交付的目标文档）。
> 本文件是**实施进度追踪**，不是设计稿；设计规则以 Handbook 为准。
> 每批次完成后更新本文件的 Status 与"已完成落点"，供后续轮次续接。

## 核心不变量（实施时不得偏离）

1. **三个独立动作**：发布新版本 / 重测指定版本 / 切换有效版本策略互不耦合。
2. **两个作用域**：题库策略与「竞赛 × 题目」策略独立，各自有 revision。
3. **跨版本保留**：`submission_version_results` 每（提交，版本）一条当前正式判定；
   `any` 取全部候选，`exact(X)` 只取 X；`is_accepted` 与最高分指针分别独立选择。
4. **提交时版本不可变**：`submitted_version_id` + `version_origin` 创建后不修改；
   历史未知版本用 `legacy_unknown`，**不得**伪造为迁移基线 V1。
5. **终态只写一次**：评测尝试终态不可覆盖；平台错误不替换已有正式判定。
6. **策略立即生效**：不依赖 TTL 或异步视图刷新；缓存键含 revision。
7. **内容事实源是 `problem_versions.content`**；`problems` 上的内容字段只是最新版投影。

## 批次进度

| # | 批次 | 状态 | 备注 |
|---|---|---|---|
| 1 | 基础模型（schema/类型/纯计算器/PGlite DDL/迁移） | 已完成 | 迁移 `0102`；1255 用例全绿；存量库演练通过 |
| 2 | 版本写入（草稿、发布、文件引用、OI、客观题快照） | 进行中 | 2a 存储登记、2b 草稿/发布已完成；2c/2d/2e 待做 |
| 3 | 评测链路（attempt、协议、结果事务、LLM、sweeper、自测） | 未开始 | |
| 4 | 管理操作（策略、后台任务、管理员重测、用户升级） | 未开始 | |
| 5 | 读取统一（通过状态、题单、排行、资料、社区、搜索、正式成绩） | 未开始 | |
| 6 | 客户端（Web、IDE、CLI、演练） | 未开始 | |
| 7 | 存量收尾（迁移回填、旧表删除、备份恢复验证） | 未开始 | |
| 8 | 文档与交付（现行文档、Agent Note、验收、PR） | 未开始 | |

## 批次 2 落点清单

- [x] 2a `StorageProvider.stat()`（local 文件元数据 / S3 HEAD）+ 存储对象登记服务
      `src/domains/system/services/storage/registry.ts`：登记、核实、引用统计、
      引用守卫删除、上传补偿（有引用时不误删共享对象）。
- [x] 2b 草稿服务 `catalog/services/versioning/draft.ts`（revision 乐观锁 428/409、
      派生初值、草稿文件引用 upsert/替换）与发布服务
      `catalog/services/versioning/publish.ts`（预检 → 锁内复查 → 哈希去重 →
      版本分配 → 引用复制 → 投影/基线更新 → 审计/搜索事件）。
- [x] 2b `ProblemContentV1` 内容模型 `catalog/types/problem-content.ts`
      （canonical JSON 哈希、完整性校验、题型/提交模式不可变断言）。
- [x] 2b 审计动作 `problems.version_published` 等 4 项（TS 联合 + DB CHECK + 迁移）。
- [ ] 2c 支持包上传/下载绑定草稿与版本；OI `saveOiMetadata`/`saveOiData`/`loadOiData`
      按 draft/version 来源读写；OI 自测从版本构造临时包。
- [ ] 2d 客观题小题写入草稿 content、稳定 key、按版本快照重判。
- [ ] 2e `createProblem` 建身份+草稿；内容更新转草稿；`updateProblem` 管理信息与内容
      分离；`deleteProblem` 补齐新表清理顺序；路由新增草稿/版本接口。

### 批次 2 决策与偏差记录

- **草稿 revision 语义**：数据库无草稿行表示 `revision = 0`（内容由最新版投影派生），
  首次保存写入 1，与列默认值一致；每次成功保存 = 当前 + 1。发布成功后草稿保留、
  基线指向新版本并再递增一次 revision。`unchanged` 发布**不**改 revision（没发生写入）。
- **内容哈希去重**：发布把内容哈希（规范化内容 + 按 role/path 排序的文件哈希）作为
  唯一性判据，说明/操作者/时间不入哈希，因此"内容相同 + 不同发布说明"仍是
  `unchanged: true`。
- **投影**：发布同时更新 `problems` 最新版投影（含 `oi_data_files` 与
  `support_package_storage_url`），让既有列表/编辑器读取路径在迁移期不失效。

### 批次 2 验证证据（截至目前）

- catalog 域 `bash scripts/test-domain.sh catalog`：**284 passed / 0 failed**。
- system 域 `bash scripts/test-domain.sh system`：**141 passed / 0 failed / 1 ignored**。
- 新增用例：存储登记 7 个（引用守卫删除、共享对象不误删、stat）、草稿/发布 9 个。
- 迁移门禁：parity 68 表 / 613 列；迁移安全通过；快照链通过。
- 真实 PG 存量演练：开发库克隆（85 条审计 + 123 条提交）→ 应用 `0102` →
  审计行全保留且新 CHECK 生效、提交标记 legacy_unknown。

## 批次 1 落点清单

- [x] `src/shared/db/schema/catalog.ts`：`problems` 策略字段；`problem_versions`、
      `problem_drafts`、`problem_draft_objects`、`problem_version_objects`。
- [x] `src/shared/db/schema/system.ts`：`storage_objects` 登记表。
- [x] `src/shared/db/schema/submission.ts`：`submissions` 版本/投影字段；
      `evaluation_attempts`、`submission_version_results`、`submission_jobs`、
      `submission_job_items`；`self_tests` 版本与快照字段。
- [x] `src/shared/db/schema/objective.ts`：`objective_submissions` 同构字段。
- [x] `src/shared/db/schema/contest.ts`：`contest_problems` 固定版本与策略字段。
- [x] `src/shared/db/schema/query.ts`：`query_projection_revisions`（query 域所有）。
- [x] `src/shared/db/schema-ddl.ts`：PGlite 同步（含 partial index 与复合外键）。
- [x] `src/shared/versioning/*`：纯类型 + `selectEffectiveResults` 纯计算器 + SQL 谓词。
- [x] `drizzle/01xx_*.sql`：新表、可空列、约束、索引、版本不可变 UPDATE 守卫。
- [x] 测试：纯计算器单测 + schema/DDL parity 门禁。

### 批次 1 决策与偏差记录

- **复合外键的 Drizzle 表达**：`problems.latest_version_id` / `required_version_id`
  指向 `problem_versions(problem_id, id)`。`drizzle-orm@0.45` 的 `foreignKey()`
  需要在定义处立刻求值列数组，无法同文件内前向引用；因此把 `problem_versions`
  定义在 `problems` **之前**（`problem_id → problems.id` 走惰性 `.references()`），
  从而使两个方向的复合外键都能在 schema 中声明。
- **`contest_problems.pinned_version_id` 的 NOT NULL**：按 Handbook §8.1 的顺序，
  先加可空列（本批次），在批次 7 的存量回填迁移里回填后再 `SET NOT NULL`。
  直接 `ADD COLUMN ... NOT NULL` 会让存量库升级失败（`scripts/check-migration-safety.ts`
  强制门禁）。
- **`ON DELETE` 语义**：复合外键一律 `NO ACTION`（MATCH SIMPLE，任一列为 NULL
  即不校验）。PG 的复合外键 `SET NULL` 会把所有引用列置空（含 NOT NULL 的
  `problem_id`/`paper_id`），需 PG15+ 的列清单形式，故不使用；删除整题仍走既有
  应用层清理流程。
- **版本不可变守卫**：`problem_versions` 的 UPDATE 守卫以 `0102` 迁移尾部的
  `noj_problem_versions_immutable()` 触发器实现（PGlite DDL 同步），唯一例外是
  迁移基线的 `content_sha256` 由 NULL 回填为实际哈希。
- **`version_origin` 的默认值是 `legacy_unknown`（过渡桥）**：迁移 `0102` 之后、
  提交写入链路改造（批次 3）之前，既有代码路径仍不传版本。若默认 `known`，
  `(known ⇔ 版本非空)` 的 CHECK 会让**所有**提交写入失败（实测：并行测试 80 个
  用例失败）。改为默认 `legacy_unknown` 后：忘记传版本 = 诚实落成「未知版本」，
  而 API 层仍按 Handbook §4.2 拒绝缺版本的客户端请求；写入链路完成后由写入服务
  显式传 `known` + 版本 ID，不需要再改默认值。

### 批次 1 验证证据

- `deno run -A scripts/check-schema-parity.ts`：68 表 / 613 列一致。
- `deno run -A scripts/check-migration-safety.ts`：通过（无一步式 NOT NULL 加列）。
- `deno run -A scripts/check-migration-snapshot-chain.ts`：通过。
- `deno task test:parallel`：**1255 passed / 0 failed / 11 ignored**（PGlite + 真实 PG 双分片）。
- 真实 PG 存量演练：克隆开发库（123 submissions / 7 problems / 123 evaluation_results）
  → 应用 `0102` → 计数不变、123 行 `legacy_unknown`、10 张新表 + 守卫触发器就位；
  负例验证：跨题版本复合外键拒绝、已发布版本 UPDATE 被触发器拒绝、
  `exact` 缺要求版本被 CHECK 拒绝、基线哈希 NULL→哈希放行。
