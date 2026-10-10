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
| 4 | 管理操作（策略、后台任务、管理员重测、用户升级） | 进行中 | 4a 策略切换、4b/4c 派发与路由已完成；本轮补竞赛固定版本写入 |
| 5 | 读取统一（通过状态、题单、排行、资料、社区、搜索、正式成绩） | 进行中 | 5a 题目通过状态已切投影 |
| 6 | 客户端（Web、IDE、CLI、演练） | 进行中 | CLI/IDE/E2E 与 noj-ui 提交侧已完成；草稿发布编辑流、提交列表/详情、管理页待做 |
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
- [x] 2c（支持包部分）`support-package.ts`：`setSupportPackage` 写草稿引用并登记对象
      （哈希取 URL 内嵌 checksum、大小向后端核实，客户端不可注入）；下载/模板按
      「显式版本 → 最新版 → 草稿 → 迁移期投影」解析；删除草稿包走引用守卫，
      历史版本引用与字节保留。
- [x] 2c（OI 核心）新增 `versioning/oi-draft.ts`：`saveOiDraft` 在同一次草稿事务中
      切换配置 + 逐文件引用 + 打包 ZIP（`saveProblemDraftWithObjects`），
      revision 先行校验（428/409），metadata-only 复用引用并校验新配置路径，
      上传失败按引用守卫补偿；`loadOiDataFromDraft` / `loadOiDataFromVersion` 显式
      来源；`loadOiData(c, ref, { source })` 暴露来源参数（默认仍为迁移期兼容路径）。
- [x] 2d 客观题读取分流与小题草稿路由：`objective-questions.ts` 只保留套卷身份/权限
      与读取（编辑者读 `listDraftQuestions` 含答案、其他人读 `resolveProblemAnswerVersion`
      → `listVersionQuestions` 快照并裁剪答案、未发布对非编辑者 404），旧
      `createQuestion/updateQuestion/deleteQuestion`（写 `objective_questions`）删除；
      `catalog/routes/problems.ts` 四个小题端点改走 `objective-drafts` 服务，
      `If-Match`/`expected_revision` 必填（428/409），成功响应回传 `draft_revision`，
      删除由 204 改为 200 + revision；`serializeQuestion` 的 `id` 返回稳定 `key`；
      草稿内 `sort_order` 唯一（保留原 400 语义）。
- [x] 2d 导入直写草稿：`importObjectivePaper` 生成/保留小题 UUID 作 key 并写草稿
      content（旧表保留兼容镜像供 `legacy_unknown` 展示），`publishImportedProblem`
      统一发布当前草稿 revision；`questions.json` 新增可选 `key`
      （`ObjectiveQuestionBundleInput`，非空 / 同包不重复）。
      证据：catalog 域 **307 passed / 0 failed**；objective 域 **56 passed / 0 failed**；
      noj-core 全量 **1408 passed / 0 failed / 11 ignored**。
- [x] 2c（OI 收尾 / 2e）路由改走 `saveOiDraft`（`oi-author.ts`）：
      `POST /problems/oi-author/:id/save` 以 `metadata.draft_revision` 为唯一乐观锁
      （缺失 → 428、过时 → 409、不再用 `updated_at`），管理信息（难度/标签/可见性）
      与内容分离（前者 `updateProblem`、后者 `saveOiDraft`）；`GET /:id/files` 与
      `GET /:id/file` 改为**草稿作用域**（新增 `listDraftOiFiles` 用存储登记字节数
      列目录，避免为列目录下载测试数据）；`saveOiMetadata` / `saveOiData` 删除。
      `updateProblem` 内容→草稿、管理信息→题目行（未发布题目同步投影以保持迁移期
      可读）；导入路径改为「写草稿 → 显式 publish」（客观题先同步小题），
      `createViaCrud` 补建草稿 + 支持包草稿引用，旧评测包删除统一走引用守卫。
      剩：ZIP worker 结果绑定 revision、OI 自测从版本构造临时包。
      证据：catalog 域 **306 passed / 0 failed**（新增 OI 路由 2 例 + 版本路由 2 例）；
      noj-core 全量 `deno task test:parallel` **1406 passed / 0 failed / 11 ignored**；
      noj-ui `deno task test` **235 passed** + `test:components` **102 passed / 19 文件** +
      `check:types` / `check:types:nuxt` 0 error；lint / fmt / 域边界 / JSDoc /
      迁移安全 全绿。
- [x] 2d 客观题：`objective/services/versioning/objective-drafts.ts`（小题读写只在草稿
      content 内，key 跨版本稳定，新增生成 UUID、导入必须显式 key 且不猜测对应关系）
      与 `objective-regrade.ts`（按版本快照 key 匹配重判：新增小题按未作答、
      删除小题不计分、答案形式不兼容按未作答、原始 answers 不改写）。
- [ ] 2d（收尾）旧 `objective_questions` 运行期读取迁移（批次 6/7：导入路径改草稿 +
      可选发布；派生初值仅在无版本时兜底）。
- [x] 2e（草稿/版本路由）`catalog/routes/problems.ts` 新增 Handbook §4.1 接口面：
  - `GET /problems/:id/draft`（编辑者，派生初值 `synthesized`）、
    `PUT /problems/:id/draft`（`If-Match` 优先、body `expected_revision` 其次；
    缺 revision → 428，过时 → 409）、
    `GET /problems/:id/draft/preflight`（`?verify=false` 跳过物理对象核实）、
    `POST /problems/:id/versions`（发布，`unchanged` 时 200，新版本 201）、
    `GET /problems/:id/versions`（分页元数据）、
    `GET /problems/:id/versions/:versionId`（历史版本内容，非编辑者裁剪客观题
    标准答案与解析；读取沿用题目当前访问权限与竞赛保密，选旧版不能绕过保密）；
  - 编辑权限抽成唯一入口 `assertProblemEditPermission`（P 型 `write_any`、
    U 型 owner `write_own`、其余 `write_any`），既有 `PUT /problems/:id` 与新路由
    共用，避免"草稿接口是旁路"；
  - 路由测试 5 个（派生草稿、428/409、预检→发布→重复发布 unchanged、客观题版本
    裁剪、非编辑者 403）。
- [x] 2e（创建即建草稿）`createProblem` 在写入题目行后**显式建立共享草稿**
      （初值 `deriveDraftContentFromProblem`，revision 1），失败回滚题目行；
      服务端派生的支持包对象同时登记并写入草稿文件引用（发布时随版本固定）。
- [x] 2e（删除清理）`deleteProblem` 补齐版本化新表清理顺序：收集投影支持包 +
      草稿/版本文件引用 → 删 evaluation_results/submissions → 删 self_tests →
      删客观题提交（`submitted_version_id` 复合外键 NO ACTION 会挡版本删除）→
      删草稿/版本文件引用 → 摘掉 `latest_version_id`/`required_version_id` 指针 →
      删草稿（base_version 外键）→ 删版本 → 删题目行 → 存储对象统一走
      **引用守卫**删除（内容寻址共享对象不误删）。此前任何已发布版本的题目都
      无法删除（FK 违约 → 500），属批次 1 引入的运维死锁。
- [ ] 2e（收尾）`updateProblem` 管理信息与内容分离（内容写草稿，不直接改投影，
      需与 2c 的 OI 草稿路径切换同步落地）。

### 批次 2 决策与偏差记录

- **草稿 revision 语义**：数据库无草稿行表示 `revision = 0`（内容由最新版投影派生），
  首次保存写入 1，与列默认值一致；每次成功保存 = 当前 + 1。发布成功后草稿保留、
  基线指向新版本并再递增一次 revision。`unchanged` 发布**不**改 revision（没发生写入）。
- **内容哈希去重**：发布把内容哈希（规范化内容 + 按 role/path 排序的文件哈希）作为
  唯一性判据，说明/操作者/时间不入哈希，因此"内容相同 + 不同发布说明"仍是
  `unchanged: true`。
- **投影**：发布同时更新 `problems` 最新版投影（含 `oi_data_files` 与
  `support_package_storage_url`），让既有列表/编辑器读取路径在迁移期不失效。

### 批次 4 落点清单

- [x] 4a `submission/services/versioning/effective-policy.ts`：
  - `setProblemEffectiveVersionPolicy`：乐观锁 + 版本校验 + **同事务重算全部该题提交投影**
    （策略提交后立即生效），返回新 revision 与受影响提交数；
  - `setContestProblemEffectiveVersionPolicy`：竞赛 `exact(X)` 同时固定作答版本为 X；
  - `upgradeContestProblemPinnedVersion`：单独升级固定版本不改策略；与现有 exact 冲突
    且未同时提交新策略 → 409（`CONTEST_PROBLEM_VERSION_POLICY_CONFLICT`）；
  - 审计动作 `problems.effective_version_policy_changed` /
    `contest.problem_effective_version_policy_changed` / `contest.problem_version_changed`。
- [x] 4b（受理）`submission/services/versioning/rejudge-jobs.ts`：三种范围（selected 上限 500
      并去重 / problem / contest）、三种目标（`submitted` 未知版本 → 条目 skipped
      `LEGACY_VERSION_UNKNOWN`；`latest` 受理时解析固定；`specified` 任一题缺版本 →
      整次 400 且不产生任务）、幂等键（同请求复用 / 不同请求 409 / 跨 actor 独立）、
      空集合直接完成、`policy_changes` 作用域与 revision 校验（全部校验通过才应用）、
      `retryRejudgeJob`（仅 failed/skipped、保留版本映射、不改策略）、
      `refreshJobStatus`（由条目聚合，无进程内计数器）。
- [x] 4b（worker 原语）`submission/services/versioning/job-worker.ts`：
  `claimJobItems`（独立短事务 + `FOR UPDATE SKIP LOCKED` + preparing/lease）、
  `renewJobItemLease`、`markJobItemDispatched`（条件更新，结果早到不回退终态）、
  `completeJobItem`（幂等终态 + 自动聚合任务状态）、
  `scheduleDispatchRetryOrFail`（1/2/4/8/16 秒退避，超限 failed）、
  `requeueJobItem`（容量不足不计失败）、`requeueExpiredLeases`（崩溃恢复）。
  结果落库时自动完成条目：graded（含 WA/零分）→ `succeeded`；
  平台错误 → `failed` + `PLATFORM_ERROR`。
- [ ] 4b（派发 + 注册）条目派发：按目标版本构造 Judge 任务（版本内容为唯一配置来源）、
  建重测尝试（sequence 递增）、`run_id = attempt_id`、artifact 缺失 → `ARTIFACT_MISSING`、
  语言/大小校验；worker 注册进 `main()` 后台消费者并接入关闭流程。
- [x] 4c（升级受理）`submission/services/versioning/upgrade-jobs.ts`：
  `acceptUpgradeJob`（≤500、受理时去重与固定目标版本、`practice` 用最新版 /
  `source_contest` 用竞赛固定版、幂等键含 context 哈希）、跳过原因
  （`ALREADY_LATEST` / `SOURCE_DELETED` / `SOURCE_JUDGING` / `NO_PUBLISHED_VERSION` /
  `CONTEST_VERSION_UNKNOWN`）、跨用户升级 403、`getUpgradeJobForActor`（本人或管理员）。
- [x] 4c（升级派发）升级条目创建**新提交**后再评测，原提交与原成绩完全不动：
  - 代码/产物：新提交沿用原用户与原始代码/产物、`upgraded_from_id`、当前时间、
    `context=source_contest` 时保留原竞赛（否则落练习）；入队成功后条件置
    `judging`；派发失败删除新提交（不留孤儿）；
  - 客观题：新提交一律落**练习**（竞赛一次性提交限制不适用于升级），按目标版本
    快照同步重判，并同步提交行的 `score`/`details`（最近一次 graded 执行的投影）；
  - 条目写 `result_submission_id`，`ALREADY_LATEST` 在派发侧兜底跳过。
- [x] 4b/4c（HTTP 路由）
  - `POST /admin/submission-jobs`（`Idempotency-Key` 必填、202 + 任务 ID）、
    `GET /admin/submission-jobs/:id`、`/items`（分页 + status 过滤）、
    `POST /:id/retry`（无 failed/skipped 条目 → 400；重试保留目标版本映射且不改策略）；
  - `POST /submission-upgrade-jobs`（用户受理升级）、
    `GET /submission-upgrade-jobs/:id`（本人可读、他人 403、管理员可读任意）；
  - 新路由独立挂载 `/api/v1/admin/submission-jobs`（不复用 `/admin/submission` 前缀）。
- [x] 4c（旧入口适配）`submissions-rejudge.ts` 从 ~460 行的自带派发实现收敛为
      薄适配层（~130 行）：单条/整题重测一律调用 `acceptRejudgeJob`，目标固定
      `submitted`，整题**无 500 条总量限制**；不再改提交状态、不再预增
      `rejudge_seq`、不再直推 MQ；`submissions.rejudge` 审计保留（单条
      submission 维度 / 整题 problem + count）；管理端两个旧接口返回 202 +
      `job_id`/`total_items`。
- [ ] 4c（收尾）管理入口「代他人升级」需给 `acceptUpgradeJob` 增加管理员旁路。

### 批次 3 落点清单（提前完成的部分）

- [x] 3a `submission/services/versioning/projection.ts`：§3.1 的四个唯一入口中的三个
      （`recomputeSubmissionProjection` / `recomputeProblemProjections` /
      `recomputeContestProblemProjections`）与 `upsertCurrentVersionResult`
      （§2.9 当前判定写入），并在业务事务内递增 `query_projection_revisions`。
- [x] 3b 提交时版本绑定：`submission/services/versioning/submission-version.ts`
      （题库显式版本、竞赛固定版本 + 客户端覆盖 409 `CONTEST_PROBLEM_VERSION_CHANGED`、
      已版本化题目缺版本 409 `VERSION_REQUIRED`、跨题版本 404、版本内容校验提交模式与
      语言）；`createSubmission` 与 `POST /submissions` 已接线并落库
      `submitted_version_id` / `version_origin`。
- [x] 3c（服务层）`attempts.ts`（创建/开始/一次性终态/superseded、sequence 递增、
      设置 `active_attempt_id` 且不触碰有效成绩指针）与 `result-write.ts`
      （§5.6 事务：锁提交行 → 忽略已处理/过时结果 → 写终态 → graded 更新分版本当前判定
      → 双口径投影重算 → 清空在途尝试 + 最近尝试/运行状态；平台错误只记终态）。
- [x] 3c（接线）`createSubmission` 创建初次尝试（sequence 0 + `active_attempt_id` +
      非敏感任务快照）；`saveEvaluationResult` 在**同一事务**内调用 `applyAttemptResult`
      （旧协议用 `active_attempt_id` 兜底解析，新协议用 `result.attempt_id`）；
      `JudgeResult` 增加协议字段（`evaluation_protocol_version`/`attempt_id`/
      `problem_version_id`/`result_kind`，全部可选以兼容旧 judge）；
      `shared/versioning/verdict.ts` 统一通过语义（与既有 `acceptedResultSql` 完全一致：
      OI 看 verdict=AC，其余正分）与平台错误状态兜底推导。
- [x] 3c（Judge 侧·协议封套）版本化 wire 契约落地：
  - `JudgeTask` 新增 `problem_version_id` / `evaluation_protocol_version`；
    `run_id` 语义收紧为**正式提交的评测尝试 ID**（`attempt_id`）；
  - core `prepareJudgeTask` 统一封套：`run_id = attempt_id`、已知版本随任务下发、
    协议号恒为 `EVALUATION_PROTOCOL_VERSION = 2`；`createSubmission` 先定尝试 ID
    再构造任务，`createAttempt({ id })` 复用同一 ID（旧行为：OI 随机 run_id、dual 无
    run_id）；
  - `JudgeResult` 新增 `run_id` / `problem_version_id` / `evaluation_protocol_version`
    / `result_kind`，judge 侧 `JudgeResult::apply_protocol(&task)` 在**状态最终确定后**
    统一回显（含取消覆写 status 之后），`result_kind` 由平台错误状态白名单推导
    （`error/SystemError/SE/FE/cancelled` → `platform_error`，其余 `graded`，
    含零分/WA）；`JudgeResult::error/system_error` 工厂恒标 `platform_error`，
    且已显式标定的类别不被覆盖；
  - core `saveEvaluationResult` 尝试定位优先级 `attempt_id → run_id →
    active_attempt_id`（旧协议兜底），`result.result_kind` 优先于状态推导；
  - 契约夹具 `noj-tests/fixtures/judge-task.contract.json` 与两侧字段表
    （`JUDGE_TASK_FIELDS` / Rust `judge_task_contract.rs`）同步；
  - `details.run_id` 保留（旧 core 的乱序防护仍在使用）。
- [x] 3c（LLM 生命周期）attempt 维度额度与吊销（Handbook §6.7）：
  - core `EvalTokenPayload` 增加 `attempt_id` / `problem_version_id` /
    `protocol_version`（`LLM_TOKEN_PROTOCOL_VERSION = 2`）；`buildJudgeTaskLlm`
    新增 scope 参数，正式提交必须传入（创建提交/artifact/重测均已接线）；
  - gateway 新增作用域助手 `evalTokenScope/CounterKey/RevokedKey/IpSetKey`：
    有 `attempt_id` 时单次额度键为 `llm:attempt:<id>:calls|tokens|cost`、吊销键
    `llm:attempt:revoked:<id>`、IP 监控键 `llm:attempt-ips:<id>`；
    旧 token（无 attempt_id）沿用 `llm:sub:*` / `llm:token:revoked:*`；
  - 结果落库后 core 吊销**本次尝试**（并继续写提交维度旧键吊销旧协议 token）；
  - `llm_usage` 增加可空 `attempt_id` / `problem_version_id` 与
    `idx_llm_usage_attempt_id`（迁移 `0004_llm_usage_attempt_scope.sql`，
    已在开发库执行验证）；拒绝审计去重键也改为 attempt 优先；
  - 同一尝试重派共享额度（同一 attempt → 同一组键），用户/题目/全局日/月额度不变。
- [x] 3b（artifact 提交版本绑定）`createArtifactSubmission` 与路由：
  - multipart 必须携带 `version_id`（先于文件流到达才消费文件；缺版本返回 409
    `VERSION_REQUIRED`，未消费的文件流主动取消）；
  - 服务端解析提交时版本（竞赛固定版本 / 题库显式版本），校验版本接受 artifact
    提交模式，产物大小上限以**目标版本** `artifact_max_size_mb` 为准；
  - 提交行写入 `submitted_version_id` / `version_origin`，创建初次尝试
    （`source='initial'`）并把 `run_id = attempt_id` 传给任务。
- [x] 3b（重测尝试）`submissions-rejudge.ts` 单条与整题路径：每次重测创建
      `source='rejudge'` 尝试（sequence 递增、绑定目标版本 = 题目当前最新版），
      任务 `run_id` 与 LLM token 均绑定该尝试。
- [x] 3c（sweeper 从版本恢复）`submission/mq/sweeper.ts`：
  - pending 正式提交优先取 `active_attempt_id` 绑定的**版本内容**作为配置来源
    （`runtime_config` / `judge_type`），任务复用原尝试 `run_id` 与
    `problem_version_id`；仅当没有尝试（迁移期存量行）才回退题目投影；
  - pending 自测走 `self_tests.problem_version_id` 的版本内容；
  - **移除产物 pending 清理路径**（`cleanupOrphanArtifacts` 删除对象 + 标记 error）：
    产物对象保留到提交显式删除，pending 产物提交改为正常恢复（重新签发下载地址、
    `code: ""`、带 `artifact_download_url`），对象缺失时按永久错误收尾并保留历史判定。
- [x] 3c（自测版本）`self-tests.ts` + 路由 + 类型：自测请求支持 `version_id`
      （显式版本逐字生效、不属于该题 404），配置以**版本内容**为准，落库
      `problem_version_id` 与非敏感 `task_snapshot`；任务携带版本与协议版本，
      自测仍使用独立运行标识。
- [x] 3d 客观题提交走统一尝试与投影写入服务：
  - `submitObjectivePaper` 判卷事实源改为**提交时版本的小题快照**
    （`loadPublishedVersionContent` → `content.questions`，key = 快照 `key`；
    未版本化存量套卷回退旧小题表，key = 旧小题 UUID）；
  - 「提交行 + 初次尝试（`source='initial'`，绑定版本，非敏感任务快照）+
    `submission_version_results` 当前判定 + 双口径有效成绩投影 + revision 递增」
    **同一事务**完成，任一步失败都不留半成品；`accepted = score >= 10000`（满分口径，
    与迁移基线一致）；
  - 提交行写入 `submitted_version_id` / `version_origin`（缺版本时诚实落
    `legacy_unknown`）；
  - **显式指定版本逐字生效**：题库提交携带 `version_id` 时不再有 catch 兜底
    （跨题/未发布版本 → 404 `PROBLEM_VERSION_NOT_FOUND`）；只有**未携带**版本时才按
    有效策略解析默认作答版本（`any` → 最新版 / `exact` → 要求版本）；
  - 提交详情按 `submitted_version_id` 还原当时的卷面解析（草稿改动不影响历史详情）。
- [x] 3d 附带修复：`applyAttemptResult` 之前把 `contest_id` 硬编码为 `null`，导致
      竞赛提交结果写入后 `is_contest_*` 恒为空、竞赛作用域 revision 不递增。
      现在提交行锁查询同时取回 `contest_id`，且 `computeSubmissionProjection` 在
      `contest_id === undefined`（调用方未取）时自行回查兜底。
- **严格化提醒（必须在上线前完成）**：`resolveSubmissionVersion` 目前对「题目尚未发布
  任何版本」的存量题目仍返回 `legacy_unknown`（迁移期兼容）。批次 7 回填迁移基线后，
  该分支必须收紧为拒绝；同时确认所有客户端（UI/IDE/CLI）都携带 `version_id`。

### 批次 2 验证证据（截至目前）

> 只记录**当前有效**的证据（旧轮次的中间数字已合并，避免误读）。

- **最新全量**：`deno task test:parallel`（PGlite unit 分片 + 真实 PG db 分片）
  **1360 passed / 0 failed / 11 ignored**（批次 3d 时点；本轮最终数字见文末"最近一次验证"）。
- 分域（最新）：catalog **292**、submission **203**（+21 ignored）、objective **55**、
  identity 310（+25 ignored）、community 71、query 25。
- 静态门禁：schema parity（68 表 / 613 列）、迁移安全、快照链、域边界、导出 JSDoc、
  `deno lint`、`deno fmt --check` 全部通过（迁移两个脚本必须在**仓库根**运行）。
- 环境注意：`queue.test.ts` 的"队列空"断言会被 **Redis 中遗留的池化队列条目**
  （如 `noj:judge:queue:ai:medium`）打破，属环境残留而非代码缺陷
  （清理该 key 后 11 个用例全绿）；`clearQueue()` 尚未覆盖资源池队列。
- 新增用例：存储登记 7 个（引用守卫删除、共享对象不误删、stat）、草稿/发布 9 个、
  内容模型与策略纯函数 7 个、有效成绩计算 9 个、版本化客观题提交 7 个、
  竞赛口径投影 1 个。
- **踩坑（重要）**：事务回调内**禁止**调用 `getDb()`——PGlite 单连接下会自锁
  （表现为测试永久挂起），且在连接池模式下会读不到未提交数据。所有域内 helper
  必须接受 `Executor` 参数并在事务内传 `tx`（`draft.ts` 的 `getProblemDraft` /
  `listDraftObjects` / `loadProblemIdentity` 已按此改造）。
- 域边界门禁 `deno task check:domains`：catalog 域必须经 `system/index.ts`、
  `objective/index.ts` **门面**导入（不得深路径）；跨域类型用 `import type` 避免运行时环。
- 测试用本地对象存储：`LocalStorageProvider` 构造函数无参数，存储根目录由
  `SUPPORT_PACKAGE_DIR` 决定，测试需在模块加载时指向临时目录。
- 踩坑记录：`@std/assert@1.0.19` 的 `assertRejects` **不接受同步 throw**，
  必须传返回 rejected promise 的函数；同步校验断言统一走 `assertThrows()` 包装。
- 读路径不再自行比较分数：题单进度（`getAcceptedProblemIds`）与客观题练习最高分
  都改读有效成绩投影（`is_accepted` / `effective_attempt_id`），因此测试夹具必须
  像结果写入服务一样显式落投影（`is_valid` / `is_accepted`），否则用例会失败——
  这是"投影即事实源"的预期行为，不是回归。
- 真实 PG 存量演练：开发库克隆（85 条审计 + 123 条提交）→ 应用 `0102` →
  审计行全保留且新 CHECK 生效、提交标记 legacy_unknown。

## 批次 5 落点清单

- [x] 5a `problems-list.ts` 的「viewer 是否通过该题」改为读取有效成绩投影
      `submissions.is_accepted`（命中 `idx_submissions_problem_accepted_user`）；
      存量由迁移 0103 回填保证与旧 `acceptedResultSql` 口径一致。
- [x] 5b（部分）query 域 `rankings.ts` / `dashboard.ts` 改读有效成绩投影
      （`s.is_accepted`），移除 `evaluation_results` JOIN；新增 **视图可信判定**
      `isRankingViewTrusted()`：`materialized_revision < data_revision` 时（版本化后
      回填把 global data_revision 置为 1）自动回退内联查询，策略切换与重测立即可见，
      不依赖视图刷新（§3.5）。
- [ ] 5b（收尾）`stats-cache.ts` 的进程内增量计数改为 revision 键控的数据库聚合 +
      Redis 缓存；通过率分母改为"当前有效且已产生正式判定的提交数"并额外返回
      `valid_submissions`；`user_rankings` 视图按新模型重建（7b）。
- [x] 5c（部分）通过门槛与进度改读有效成绩投影：
      community `hasAcceptedSolution`（题解门槛/发布入口）、
      identity `queryUserProfileAggregate` + `querySolvedProblems`（个人主页通过数/列表）、
      trainings `getAcceptedProblemIds`（题单进度；客观题已随 3d 接入投影，
      `objective_submissions.is_accepted` 即为满分口径）、
      客观题练习最高分（`listObjectiveSubmissions.best_score` 改读
      `is_valid` 提交的 `effective_attempt_id` 分数，不再用 `MAX(score)`）。
- [x] 5c（problems-stats）题目统计改读**有效成绩**（§3.2/§3.4）：
  - 样本由 `submissions ⋈ evaluation_attempts(effective_attempt_id)` 取
    `result_status`/`score`/`details`，不再 JOIN `evaluation_results`；
  - 通过数与"有效提交"直接读投影（`is_accepted` / `is_valid`），
    公开通过率分母改为 `valid_submissions`（新增字段，赛期与通过率一并抑制）；
  - 缓存键加入题目作用域 `query_projection_revisions`，策略切换后统计立即按新口径
    重算（不再只依赖 5 分钟 TTL）；`details` 兼容对象与历史文本两种形态。
- [x] 4.1（题目读取版本字段）`GET /problems/:id` 返回 `version_id` / `version` /
      `latest_version_id` / `latest_version` / `effective_version_policy` /
      `is_latest`（默认作答版本：`exact` → 要求版本，`any` → 最新版）；
      `?version_id=` 显式读取历史版本内容（沿用同一访问权限与竞赛保密，管理信息不随
      版本回退；不下发支持包存储位置与客观题答案）。
- [x] 6（CLI / IDE / E2E 携带版本）
  - `noj-core` CLI：`problems import --publish`（同步投影到草稿后显式发布，相同内容
    复用既有版本），`dev-setup` 默认带 `--publish`；`POST /problems/import-bundle`
    新增 `publish=true` 表单字段（生产演练使用）；
  - `noj-cli` 演练：导入表单带 `publish=true`，结论文案显示发布版本号；
  - `noj-lmcc-extension`：选择题目时读取并固定作答版本，提交携带 `version_id`；
    未发布题目给出明确提示（不再静默提交）；
  - `noj-tests` E2E：新增 `publishProblemVersion` / `getAnswerVersionId` 助手，
    `submitCode` 自动携带默认作答版本；artifact E2E 改为先发布再带 `version_id` 上传。
- [x] 6（noj-ui composable）`noj-ui/composables/useProblemVersions.ts`：草稿读写
      （`If-Match` 乐观锁）、发布预检/发布、版本列表与指定版本、题库/竞赛策略切换、
      竞赛固定版本升级、批任务受理（`Idempotency-Key`）/详情/条目/重试、升级任务受理与
      读取、终态轮询（不依赖进程内计数）；配套 8 个 vitest 用例
      （`noj-ui/tests/composables/useProblemVersions.spec.ts`）。
- [x] 4（竞赛固定版本落库 + 提交携带版本）
  - `createContest` 创建时把每题钉在**当时的**最新已发布版
    （`contest_problems.pinned_version_id`）；`updateContest` 整体替换题目关联时
    先读旧固定版本，已有固定版本原样保留，旧 null（加入时题目尚无版本）按当前最新版
    回填——否则"改个竞赛名"就会静默换版；
  - `POST /contests/:id/submit`（JSON 与 multipart）转发客户端 `version_id`：
    与固定版本不一致 → `409 CONTEST_PROBLEM_VERSION_CHANGED`
    （响应含 `expected_version_id`/`submitted_version_id`）；缺省版本仍按固定版本
    作答（迁移期兼容，批次 7 后收紧为 `VERSION_REQUIRED`）；
  - 新增 3 个用例：contest 域固定版本 2 个（创建即固定 / 编辑保留 + 新题固定）、
    contest 路由 1 个（固定版本下发、旧版本 409、一致与缺省放行、落库
    `submitted_version_id` 均为固定版本）。
- [x] 6（noj-ui 提交侧版本贯通）
  - `pages/problems/[id].vue`：作答版本提示条（题库固定 / 最新版 / 未发布）+ artifact
    提交携带 `version_id`，409（`VERSION_REQUIRED` / `CONTEST_PROBLEM_VERSION_CHANGED`）
    只刷新题目、不自动换版；
  - `pages/editor/[id].vue`：`submit()` 与 `selfTest()` 携带 `version_id`，工作区副标题
    显示"作答版本 vN"，409 刷新题目且代码留在编辑器；
  - `composables/useObjective.ts` + `components/objective/ObjectiveAnswerForm.vue`：
    客观题提交（练习/竞赛）携带 `version_id`；
  - `pages/contests/[contestId]/problems/[label].vue`：固定版本提示条 + artifact/客观题
    提交携带 `version_id` + 409 保留已写内容并刷新固定版本；
  - 新增 `isVersionConflictError()`（`utils/apiError.ts`）与 3 个版本错误码中英文案；
    `ProblemView` / `ProblemResource` / `ContestProblemResource` / `ContestProblem`
    补齐版本字段；8 → 10 个相关单测。
- [x] 5/6（提交读路径版本信息）
  - `GET /submissions/:id` 新增 `submitted_version_id` / `version_origin` /
    `submitted_version` / `upgraded_from_id` / `effective_version_policy` /
    `version_results[]`：每（提交，版本）一条当前正式判定（尝试序号、状态、分数、
    耗时/内存），`is_effective` / `is_accepted` 由 `selectEffectiveResults` 按**题目
    作用域策略**统一解析（`exact(X)` 下通过指针同样只在 X 内选择，与写侧口径一致）；
  - 列表项新增 `submitted_version_id` / `version_origin` / `submitted_version`
    （LEFT JOIN `problem_versions` 取版本号）；
  - `noj-ui`：详情页新增"作答版本"元信息（未知历史版本显式标注，不显示成 v0）、
    「各版本判定」表格与"由旧版本提交升级而来"来源链接；列表页新增版本列；
    新增 `submissionVersionLabel()` 与单测。
- [x] 6（提交列表筛选与批量升级入口）
  - core：`listSubmissions` 新增 `versionId` / `versionOrigin` / `validOnly` /
    `acceptedOnly` / `upgradable`；`upgradable` 口径为"题目已有最新已发布版且
    本提交的提交时版本 ≠ 最新版"（未知历史版本也进入候选，由任务条目按
    `LEGACY_VERSION_UNKNOWN` 处理）；路由校验非法 `version_origin` → 400；
  - noj-ui `pages/submissions/index.vue`：作答版本筛选（已知 / 未知历史）、
    "仅显示可升级""仅显示有效成绩"开关、行勾选与全选、批量升级按钮
    （≤500 条、幂等键、轮询任务到终态、按 `reason_code` 聚合失败原因）、
    版本列展示（`submissionVersionLabel`）。
- [x] 5（stats-cache 去进程内状态 + 读有效投影）
  - 删除 `fallbackTotal` / `fallbackTotalFullScore` / `fallbackTodayTotal` /
    `fallbackTodayFullScore` / `fallbackTodayDate` 全部进程内计数器：缓存未命中或
    Redis 不可用时直接走数据库聚合，任何副本口径一致（AGENTS 多副本约束）；
  - 满分计数改读**有效成绩投影**（`submissions.is_valid` + 有效尝试
    `evaluation_attempts.score`），不再 JOIN 即将删除的 `evaluation_results`；
  - Redis 缓存键包含全局投影 revision（`noj:stats:total:r<rev>` /
    `noj:stats:today:<date>:r<rev>`）：策略切换/判定替换后立即换键，
    不依赖 10s TTL；`applyNewResult()` 只做 SCAN 前缀失效 + SSE 通知，签名去掉
    分数/时间参数（进程内不再需要它们）；
  - 测试改为数据库驱动：重复 `applyNewResult()` 不重复计数、revision 换键后立即读
    新口径、今日口径按提交时间过滤。
- [x] 4.5（策略与固定版本 HTTP 端点 + 管理端页面）
  - 新增 `noj-core/src/domains/admin/routes/problem-versions.ts` 并在 admin 组合路由
    中以 `/` 前缀挂载（路径与 Handbook §4.5 完全一致）：题库策略、竞赛×题目策略、
    竞赛固定版本升级；`policy` 与 `expected_revision` 一律服务端校验（400），
    过时 revision → 409 `EFFECTIVE_POLICY_REVISION_CONFLICT`，
    固定版本与现有 exact 策略冲突 → 409 `CONTEST_PROBLEM_VERSION_POLICY_CONFLICT`；
  - 题目详情新增 `effective_version_policy_revision`；竞赛题目列表新增
    `effective_version_policy` / `effective_version_policy_revision`（管理端乐观锁）；
  - 竞赛题目列表 `user_status` 改读 `submissions.is_contest_accepted` 投影
    （去掉对 `evaluation_results` 的运行期依赖，策略收紧后通过状态立即变化）；
  - noj-ui 新增 `pages/admin/problem-versions.vue`（管理端导航「版本策略」）：
    题库策略 any/exact 切换、竞赛逐题固定版本升级与策略切换；
  - noj-ui 新增 `pages/admin/submission-jobs.vue`（管理端导航「批量重测」）：
    三种范围（整题 / 整场 / 手选 ≤500）× 三种目标（提交时版本 / 最新版 /
    「全部用 V<n>」前端展开为逐题映射，任一题缺该版本即取消受理）、条目进度与
    `reason_code`、重试 failed/skipped 生成关联新任务。
- [x] 5/7（运行期读路径去 `evaluation_results`，第二批）
  - 用户主页「最近提交」改读**最近一次终态尝试**（`latest_attempt_id`，
    存量行回退 `effective_attempt_id`），不再 JOIN 旧结果表；
  - 个人数据导出（`me-data-export`）分数同口径；
  - 评测队列「最近完成」的分数改为尝试分数（`scoreFromEval` 布尔参数改为
    显式尝试指针，杜绝再次误接旧表）；
  - 站点统计 `GET /api/v1/stats` 的 `accepted` 改读 `submissions.is_accepted`
    有效成绩投影；
  - 四处均补测试（identity +1、query +1）。
- [x] 5c（未发布题目不进公共读取面 + 搜索只索引已发布题目）
  - `GET /problems/:id`：尚未发布任何版本的题目对普通访问者一律 404，
    编辑者（owner/admin）仍可读取——编辑入口依赖该路径；发布后自动开放；
  - `GET /problems` 公共列表（非 owner/admin 视角）新增
    `problems.latest_version_id IS NOT NULL`，草稿题目不进公共列表；
  - 搜索索引 `buildProblemEntry` 只索引已发布题目（`latest_version_id IS NOT NULL`），
    草稿内容不进公开索引，未发布题目的存在性也不经索引泄露；
  - 测试夹具补齐：新增 `tests/helper.ts` 的 `publishBaselineVersionForTest` /
    `publishAllProblemsForTest`（直接插题目行的夹具需显式发布基线版本），
    修正 catalog 3 处、search 4 处夹具。
- [x] 5/7（运行期读路径去 `evaluation_results`，第三批）
  - `getSubmission` 的最近结果、`listSubmissions` 的列表摘要改读最近终态尝试
    （`latest_attempt_id` → 存量回退 `effective_attempt_id`），无尝试指针时
    `result` 为 null（**不回退旧结果表**）；尝试 details 兼容 jsonb 与历史文本；
  - 竞赛**结算就绪**（`getContestSettlementStatus`）改读尝试指针，并按
    `result_kind = platform_error` 区分平台失败与正常未通过（pending 不再吞掉失败行）；
  - 剩余 `evaluation_results` 运行期引用：`contest-ranking.ts` 的 Kaggle 排名
    SQL（3 处，需按 `is_contest_valid` + 竞赛有效尝试迁移）、`submissions-result.ts`
    的双写、`submissions-crud.ts`/`problems-crud.ts` 的删除清理与 schema 定义。
- [x] 5d（正式成绩快照归因，第一步）
  - Kaggle 排名 SQL 的每题结果新增 `effective_attempt_id`（竞赛口径有效尝试）、
    `submitted_version_id`、`pinned_version_id`、`version_policy`（any/exact）、
    `policy_revision`，随 `jsonb_build_object` 写入正式快照 payload；
  - `KaggleProblemScore` 类型同步；快照仍是"既有快照保留、修订走新快照"（版本递增）；
  - 新增用例：exact(V2) 竞赛 + 已知提交时版本的提交 → 快照 payload 含
    `version_policy = {mode:'exact',version_id}`、`policy_revision = 3` 与尝试/版本归因。
  - 说明：实时 Kaggle 榜的计分来源已在同一轮迁移到
    `is_contest_valid` + `contest_effective_attempt_id`（见下一条落点）。
- [ ] 5d 正式成绩快照记录每题版本策略、有效尝试与提交时间。

## 批次 8 落点清单

- [ ] 新增用户/管理员版本管理文档 + 同步现行文档（README/AGENTS/题型/题包/题单/提交/竞赛/升级）。
- [ ] Agent Note（`.agents/notes/implemented/`）：有效成绩物化、独立作用域、跨版本保留、协调升级。
- [ ] 全量验收（core 各域 + shared + judge + gateway + UI + E2E）与迁移演练，PR 合入 `main`。
- [ ] **删除临时进度跟踪文件** `.agents/tasks/problem-version-management.md`（实施期脚手架，
      交付后不得留在仓库；删除前确认无其它引用，见该文件文末清单）。

## 批次 7 落点清单

- [x] 7b 第一步：**停止写入旧结果表**。`submissions-result.ts` 移除
      `evaluation_results` 的 select/delete/insert 双写——评测事实唯一来源为
      `evaluation_attempts` 终态 + `submission_version_results` 当前判定 + 有效成绩投影；
      7 个断言旧表的用例改写为断言新事实（尝试终态字段、重复消费不产生多次尝试、
      重测时旧尝试历史保留且投影 `latest_attempt_id` 指向新尝试、非法 seq 不覆盖终态、
      自测不产生正式尝试）。
- [x] 7b 第二步：**清空全部旧表引用**。12 个测试文件的夹具改写为「提交 + 尝试 +
      投影指针」或直接删除旧结果行；`problems-crud.ts` 删除清理移除（尝试随提交级联）。
      这一步暴露并修复了两处真实问题：
      1. 结算门禁 fail-open——`failed` 表达式在三值逻辑下为 NULL 时既不算 failed
         也不算 pending，"无尝试的提交"被静默放过；改为 `COALESCE(..., FALSE)`；
      2. `user_rankings` 物化视图仍基于旧表——停写后视图必然为空，
         迁移 `0104_rebuild_user_rankings_view.sql` 重建到 `submissions.is_accepted`。
- [x] 7b 第三步：**删除旧表 `evaluation_results`**。迁移
      `0105_superb_major_mapleleaf.sql`（`deno task db:generate` 生成，附中文前置条件
      说明：读路径迁移、双写移除、0103 回填、0104 视图重建）；移除 Drizzle schema 定义；
      同步 `schema-ddl.ts`（建表段/两个索引/`ALL_TABLES`）；顶层 `tests/db/schema.test.ts`
      的旧表契约用例改写为 `evaluation_attempts` 契约；parity 门禁自动收敛为
      **67 表 / 604 列**；PGlite 模板重建；开发库应用后 `public.evaluation_results`
      已不存在。全量 `deno task test:parallel` **1403 passed / 0 failed / 11 ignored**。
- [ ] 7b 第三步：`contest_problems.pinned_version_id` 收紧 NOT NULL；重建用户榜单
      物化视图与搜索索引；备份/恢复演练。
- [x] 迁移 `0103_version_backfill.sql`（drizzle-kit 生成的索引/默认值段 + 手写回填段）：
  - A 为每道现有题目建 `migration_baseline` V1（内容取自题目投影；客观题小题用 UUID 作 key）；
  - B 设置 `latest_version_id`；C 为现有竞赛固定基线版本；
  - D 基线文件引用（支持包固定 `package.zip` + OI 逐文件；存量对象登记为 `unknown`）；
  - E/F 既有结果转 `legacy_import` 尝试（普通题用 `evaluation_results`；客观题用提交自带分数，
    通过标准 = 满分）；G 未知版本桶当前判定；
  - H/I 初始有效属性（题库口径 + 竞赛口径，默认 `any` 策略）；
  - J 初始化 `query_projection_revisions(global)`。
- [x] **真实存量库演练**：克隆开发库（123 提交 / 7 题 / 123 结果）→ 应用 0102+0103 →
  7 基线、123 legacy 尝试、123 未知桶判定、123 有效投影，**与旧读取口径逐条比对 0 差异**；
  回填段重复执行幂等（无新增行）。开发库已按同路径升级。
- [ ] 7b 大库分批重算投影、`pinned_version_id` 最终 NOT NULL、删除旧
  `evaluation_results` / `objective_questions`、重建榜单物化视图与搜索索引。

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

## 最近一次验证

- 批次 7b（删除旧表 `objective_questions`）：迁移 `0107_military_zarek.sql`
  （`DROP TABLE ... CASCADE` + 前置条件说明）；运行期读写全部迁离（客观题判卷
  只用版本快照、`legacy_unknown` 按空卷面、草稿派生不再读旧表、题包导入不再镜像
  写入）；schema/DDL/parity 收敛为 **66 表 / 594 列**；PGlite 模板重建；
  开发库已应用（迁移数 108，`public.objective_questions` 不存在）。
  证据：noj-core 全量 PG 分片 **1409 passed / 0 failed / 11 ignored**；
  PGlite 单进程 **1734 passed / 0 failed / 59 ignored**；parity / 迁移安全 /
  快照链 / 域边界 / JSDoc 全绿。

- 批次 7b（竞赛固定版本收紧 NOT NULL）：迁移 `0106_flowery_iceman.sql`
  （未发布且被竞赛引用的题目补 `migration_baseline` V1 → 回填固定版本 → DO 块门禁 →
  `SET NOT NULL`）；`assertContestProblemAddable` 拒绝未发布题目（400）；
  新增 `insertContestProblems` 夹具替换 31 处直接插入；`seedRunningContest` 补版本行。
  证据：noj-core 全量 PG 分片 **1409 passed / 0 failed / 11 ignored**、
  PGlite 单进程 **1734 passed / 0 failed / 59 ignored**；contest 域 **86**、
  catalog 域 **308**；parity 67 表 604 列、迁移安全、快照链全绿；
  **真实库存量演练**（独立 schema 复现迁移前 2 行空固定版本 → 执行 0106 → 全部回填 +
  客观题基线 kind/small题 key 正确 + 列 NOT NULL）通过。
  顺带修复测试隔离缺陷：`LocalStorageProvider(storageDir?)` 显式目录取代
  7 个测试文件的 `Deno.env.set("SUPPORT_PACKAGE_DIR")` 进程级污染。

- 批次 2d（客观题小题写草稿 + 读取分流 + 导入直写草稿 + 客观题编辑器发布流）：
  noj-core 全量 `deno task test:parallel` **1408 passed / 0 failed / 11 ignored**；
  objective 域 **56 passed / 0 failed**（新增"编辑者读草稿、作答者读版本快照"用例；
  7 个原用例改为草稿 revision 链 + 先发布 V1）；catalog 域 **307 passed / 0 failed**
  （小题 key 解析用例；客观题导入用例改走真实题包 + 显式 key/缺省生成断言）；
  noj-ui `deno task test` **235 passed**、`test:components` **102 passed / 19 文件**、
  `check:types` / `check:types:nuxt` 0 error；noj-tests `deno check` 通过
  （本地无 E2E 栈）；lint / fmt / 域边界 / 导出 JSDoc / 迁移安全全绿。

- 批次 2c/2e（OI 路由切草稿 + 内容写草稿、管理信息写题目行 + 编辑器两动作）：
  noj-core 全量 `deno task test:parallel` **1406 passed / 0 failed / 11 ignored**；
  catalog 域 **306 passed / 0 failed**；noj-ui `deno task test` **235 passed**、
  `test:components` **102 passed / 19 文件**、`check:types` / `check:types:nuxt`
  0 error；`deno lint` / `deno fmt --check` / 域边界 / 导出 JSDoc / 迁移安全全绿。

- 批次 7b（第三步：删除旧表）：迁移 0105 生成并应用；schema/DDL/parity/PGlite 模板
  同步完成（parity 67 表 / 604 列）；noj-core 全量 `deno task test:parallel`
  **1403 passed / 0 failed / 11 ignored**；迁移安全与快照链门禁通过；
  `deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
- 批次 7b（第二步：清空旧表引用 + 视图重建）：submission 224 / contest 86 /
  catalog 303 / identity 310 / community 71 / query 23 全绿；noj-core 全量
  `deno task test:parallel` **1403 passed / 0 failed / 11 ignored**；
  迁移 `0104` 通过 `check-migration-safety` 与 `check-migration-snapshot-chain`，
  并已应用到开发库；`deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
  （并行测试分片 schema 因新增迁移需先 DROP 重建，脚本已按提示处理。）
- 批次 7b（第一步：停止写入旧结果表）：submission 域
  `bash scripts/test-domain.sh submission` **224 passed / 0 failed / 21 ignored**
  （7 个旧断言改写为断言尝试终态/历史保留/投影指针后仍全绿）；contest 域
  **86 passed / 0 failed**；noj-core 全量 `deno task test:parallel`
  **1403 passed / 0 failed / 11 ignored**（移除双写后未出现其它域回归）；
  `deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
- 批次 5d + Kaggle 计分迁移：contest 域 **86 passed / 0 failed**（+1 快照归因、
  +1 投影计分）；`getKaggleRanking` 改 JOIN `evaluation_attempts` +
  `is_contest_valid`，测试夹具 `insertSubmission` 改为产出"提交 + 尝试 + 竞赛有效指针"。
- 批次 5d（正式成绩快照归因）：contest 域
  `bash scripts/test-domain.sh contest` **85 passed / 0 failed**（+1：快照记录每题
  版本策略、固定版本、有效尝试与提交时版本）；noj-core 全量
  `deno task test:parallel` **1403 passed / 0 failed / 11 ignored**；
  `deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
- 批次 5/7（提交详情/列表与竞赛结算就绪读尝试）：submission 域
  `bash scripts/test-domain.sh submission` **224 passed / 0 failed / 21 ignored**
  （+1：详情/列表最近结果读最近终态尝试，且无尝试时 result 为 null 不回退旧表）；
  contest 域 **84 passed / 0 failed**（+1：结算就绪区分平台失败与正常未通过）；
  noj-core 全量 `deno task test:parallel` **1401 passed / 0 failed / 11 ignored**；
  `deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
- 批次 5（未发布题目不进公共读取面）：catalog 域
  `bash scripts/test-domain.sh catalog` **303 passed / 0 failed**（+2：
  未发布题目对普通访问者 404 而编辑者可读、公共列表排除未发布题目）；
  search 域 **30 passed / 0 failed / 1 ignored**（索引只收已发布题目）；
  noj-core 全量 `deno task test:parallel` **1399 passed / 0 failed / 11 ignored**；
  `deno fmt --check` / `deno lint` / 域边界 / JSDoc / 类型检查全绿。
- 批次 5/7（读路径去 `evaluation_results`，为删旧表铺路）：identity 域
  **310 passed / 0 failed / 26 ignored**（+1：最近提交读最近终态尝试与存量回退）、
  query 域 **23 passed / 0 failed**（+1：站点统计 accepted 读有效成绩投影）、
  submission 域 **223 passed / 0 failed / 21 ignored**；noj-core 全量
  `deno task test:parallel` **1397 passed / 0 failed / 11 ignored**；
  `deno lint` / `deno fmt --check` / 域边界 / JSDoc / 类型检查全绿。
- 批次 4/5（§4.5 策略端点 + 竞赛通过状态读投影 + 管理端页面）：
  admin 域 `bash scripts/test-domain.sh admin` **16 passed / 0 failed**（+2：
  题库策略乐观锁与参数校验、竞赛策略与固定版本升级的相互作用）；contest 域
  **83 passed / 0 failed**（+1：题目列表下发策略与通过状态读投影）；catalog 域
  **301 passed / 0 failed**；noj-core 全量 `deno task test:parallel`
  **1395 passed / 0 failed / 11 ignored**；noj-ui `deno task test`
  **235 passed / 0 failed**、`check:types:nuxt`（nuxt typecheck + vue-tsc）0 error、
  `deno lint` / `deno fmt --check` 全绿。
- 批次 5（stats-cache 去进程内状态 + 有效投影口径）：query 域
  `bash scripts/test-domain.sh query` **22 passed / 0 failed**（4 个用例重写为
  数据库驱动）；noj-core 全量 `deno task test:parallel`
  **1395 passed / 0 failed / 11 ignored**（提交列表筛选批次）后再次全量验证见下。
- 批次 6（提交列表筛选 + 用户批量升级入口）：core `GET /submissions` 新增
  `version_id` / `version_origin` / `valid_only` / `accepted_only` / `upgradable`
  筛选（服务层 + 路由参数校验）；submission 域
  `bash scripts/test-domain.sh submission` **223 passed / 0 failed / 21 ignored**
  （+2：筛选组合与非法参数 400）；noj-core 全量 `deno task test:parallel`
  **1395 passed / 0 failed / 11 ignored**；noj-ui `deno task test`
  **235 passed / 0 failed**、`check:types:nuxt`（nuxt typecheck + vue-tsc）0 error、
  `deno lint` / `deno fmt --check` 全绿。
- 批次 5/6（提交读路径版本信息）：submission 域
  `bash scripts/test-domain.sh submission` **221 passed / 0 failed / 21 ignored**
  （+2 用例：详情/列表返回提交时版本与各版本判定、策略切换后指针变化、
  `legacy_unknown` 未知版本桶）；noj-core 全量 `deno task test:parallel`
  **1393 passed / 0 failed / 11 ignored**；noj-ui `deno task test`
  **235 passed / 0 failed**；`deno task check:types` /
  `check:types:nuxt` / `deno lint` / `deno fmt --check` 全绿。
- 批次 4（竞赛固定版本）/ 6（noj-ui 提交侧）：contest 域
  `bash scripts/test-domain.sh contest` **82 passed / 0 failed**（+3 用例）；
  noj-core 全量 `deno task test:parallel` **1391 passed / 0 failed / 11 ignored**；
  noj-ui `deno task test` **234 passed / 0 failed**、
  `deno task test:components`（vitest）**102 passed / 19 files**；
  `deno task check:types` + `deno task check:types:nuxt`（nuxt typecheck + vue-tsc）
  **0 error**；`deno lint` / `deno fmt --check` 全绿。
- 批次 4.1 / 6（题目读取版本字段 + CLI/IDE/E2E 携带版本）：catalog 域
  **301 passed / 0 failed**（新增"详情返回默认作答版本与 ?version_id 读取历史版本"
  用例 + 2 个导入发布用例）；noj-core 全量 `deno task test:parallel`
  **1388 passed / 0 failed / 11 ignored**；`noj-cli` 类型检查通过；
  `noj-tests` 助手与 artifact E2E 类型检查通过；lint / fmt / 域边界 / JSDoc 全绿。
  环境说明：`noj-lmcc-extension` 的 `npm run check` 在本机因缺 `@types/node`
  与 tsconfig `moduleResolution=node10` 弃用报错（预先存在），改动文件的类型错误
  仅为这些环境性报错。
- 批次 5c（题目统计读有效成绩）：catalog 域 **298 passed / 0 failed**（统计夹具改为
  写入"提交 + graded 尝试 + 投影"真实链路）；noj-core 全量
  `deno task test:parallel` **1385 passed / 0 failed / 11 ignored**；
  `deno lint` / `deno fmt --check` / 域边界 / JSDoc / 类型检查全绿。
- 批次 4c（旧重测入口适配统一任务服务）：submission 域 **219 passed / 0 failed /
  21 ignored**（两个旧入口测试改为断言"受理不改写提交状态 + 任务已创建"，
  LLM 缺配不再卡 pending）；identity 域 **310 passed / 0 failed / 25 ignored**
  （4 个旧管理路由测试改为统一任务契约：源不存在/活跃提交/空集合均按新语义断言）；
  noj-core 全量 `deno task test:parallel` **1385 passed / 0 failed / 11 ignored**；
  `deno lint` / `deno fmt --check` / 域边界 / JSDoc / 类型检查全绿。
- 批次 4c（升级派发 + 批量任务路由）：submission 域 **219 passed / 0 failed /
  21 ignored**（新增 3 个升级用例）、admin 域 **14 passed / 0 failed**（新增 6 个
  路由用例）；noj-core 全量 `deno task test:parallel`
  **1385 passed / 0 failed / 11 ignored**；`deno lint` / `deno fmt --check` /
  域边界 / JSDoc 全绿。
- 批次 4b（条目派发 + worker 注册）：submission 域 **216 passed / 0 failed /
  21 ignored**（新增 6 个派发用例：latest 目标按版本内容构造任务、语言不接受、
  源已删除、未知历史版本、源在评测、客观题按快照重判并保留 V1 成绩）；
  noj-core 全量 `deno task test:parallel` **1379 passed / 0 failed / 11 ignored**。
- 批次 2e（创建即建草稿 + 删除清理）：catalog 域 **298 passed / 0 failed**（新增
  "删除带版本的题目清理干净"用例）；noj-core 全量 `deno task test:parallel`
  **1373 passed / 0 failed / 11 ignored**。
- 批次 2e（草稿/版本路由）：catalog 域 **297 passed / 0 failed**（新增 5 个路由用例）；
  noj-core 全量 `deno task test:parallel` **1372 passed / 0 failed / 11 ignored**；
  noj-core 全量 `deno task test:parallel` 见下方最新数字。
- 批次 3c（sweeper 版本恢复 + 自测版本）：noj-core 全量
  `deno task test:parallel` **1367 passed / 0 failed / 11 ignored**（submission 域
  **210 passed**，新增 3 个恢复用例 + 1 个自测版本用例）；lint / fmt / 域边界 /
  JSDoc 全绿。
- 批次 3c（LLM attempt 作用域 + artifact/重测版本绑定）：noj-core 全量
  `deno task test:parallel` **1363 passed / 0 failed / 11 ignored**；gateway
  `deno task test` **99 passed / 0 failed / 1 ignored**（新增 5 个作用域用例）、
  `deno task check` 通过；gateway 迁移 0004 已在开发库执行（`attempt_id` /
  `problem_version_id` / 索引就位，`llm_schema_migrations` 记录补齐）。
- 批次 3c（Judge 协议封套）：Rust `cargo nextest run --all-targets`
  **554 passed / 45 skipped**（新增 1 个封套用例 + 契约字段断言）；noj-core 全量
  `deno task test:parallel` **1363 passed / 0 failed / 11 ignored**（+3 用例：
  任务封套、OI run_id、run_id 定位尝试）；`cargo clippy` / `deno lint` /
  `deno fmt --check` / 域边界 / JSDoc / parity / 迁移安全 / 快照链全绿。
- 批次 3d（客观题版本化提交 + 竞赛口径投影修复 + 读路径统一）：
  - 分域：submission **206 passed / 0 failed / 21 ignored**、
    objective **55 passed / 0 failed**（新增 7 个版本化提交用例）、
    submission **203 passed / 0 failed / 21 ignored**（新增 1 个竞赛口径投影用例）、
    catalog **292 passed / 0 failed**。
  - 静态门禁：`deno lint` / `deno fmt --check` 全绿（含修正 `dashboard.ts` 重复
    lint-ignore 与 `rankings.ts` 未格式化）；schema parity 68 表 / 613 列、
    迁移安全、快照链、域边界、导出 JSDoc 全部通过。
  - 全量 `deno task test:parallel`：**1360 passed / 0 failed / 11 ignored**。
  - `queue.test.ts` 的"队列空"flaky 已根治：`clearQueue()` 之前只清三级旧队列
    （`noj:judge:queue:{high,medium,low}`），而 `getPendingSubmissionIds` 读**全部分池
    队列**（`ALL_JUDGE_QUEUES`），池内残留条目会让断言失败。现改为 `redis.del` 全部
    队列、推入/断言统一用 `JUDGE_QUEUES.medium`，不再手写队列名。
