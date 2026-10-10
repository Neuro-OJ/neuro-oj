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
| 4 | 管理操作（策略、后台任务、管理员重测、用户升级） | 进行中 | 4a 策略切换已完成 |
| 5 | 读取统一（通过状态、题单、排行、资料、社区、搜索、正式成绩） | 进行中 | 5a 题目通过状态已切投影 |
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
- [x] 2c（支持包部分）`support-package.ts`：`setSupportPackage` 写草稿引用并登记对象
      （哈希取 URL 内嵌 checksum、大小向后端核实，客户端不可注入）；下载/模板按
      「显式版本 → 最新版 → 草稿 → 迁移期投影」解析；删除草稿包走引用守卫，
      历史版本引用与字节保留。
- [x] 2c（OI 核心）新增 `versioning/oi-draft.ts`：`saveOiDraft` 在同一次草稿事务中
      切换配置 + 逐文件引用 + 打包 ZIP（`saveProblemDraftWithObjects`），
      revision 先行校验（428/409），metadata-only 复用引用并校验新配置路径，
      上传失败按引用守卫补偿；`loadOiDataFromDraft` / `loadOiDataFromVersion` 显式
      来源；`loadOiData(c, ref, { source })` 暴露来源参数（默认仍为迁移期兼容路径）。
- [ ] 2c（OI 收尾）路由改走 `saveOiDraft`（`oi-author.ts`）；ZIP worker 结果绑定
      revision；OI 自测从版本构造临时包并登记临时对象引用。
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
- [ ] 5c（收尾）search 索引发布内容、正式成绩快照（5d）。
- [ ] 5d 正式成绩快照记录每题版本策略、有效尝试与提交时间。

## 批次 7 落点清单

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
