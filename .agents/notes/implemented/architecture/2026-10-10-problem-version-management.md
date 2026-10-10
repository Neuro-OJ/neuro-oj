# Agent Note: 题目版本管理（草稿/发布、有效成绩物化、协调升级）

Status: implemented

## Problem

改造前 NOJ
只有「题目当前内容」这一份事实：`problems.title/description/runtime_config/
oi_data_files`
既是编辑对象，也是作答与判卷来源；`evaluation_results` 只有一条「最近一次
评测结果」，客观题小题单独存在 `objective_questions`。由此产生四类问题：

1. **改题即改历史**：编辑题面/测试数据会立刻影响所有人已经做过的提交，重测会覆盖旧成绩，
   无法回答「这次提交当时用哪一版题目评的」。
2. **无法按版本取成绩**：竞赛需要「固定题目版本」，题库需要「历史版本仍有效 /
   只认某一版」， 旧模型只有一条结果，无法同时保留 V1 AC 与 V2 WA。
3. **重测语义混乱**：单条重测、整题重测直接改写提交状态，没有可审计的任务与条目；
   用户想「用最新版重做」只能自己重新提交。
4. **不可协调升级**：评测协议没有版本与尝试标识，core/judge
   无法确认「这条结果属于哪次执行」， 重复消息可能覆盖终态。

本次交付按《题目版本管理实施
Handbook》落地数据模型、全题型版本化评测、有效成绩计算、
管理员批量重测、用户批量升级、界面、现行文档与存量迁移。

## Decision

### 1. 四个独立概念（§1.1）

题目身份（`problems`）、题目版本（`problem_versions`，发布后不可变）、提交时版本
（`submissions.submitted_version_id` /
`objective_submissions.submitted_version_id`）、
评测尝试（`evaluation_attempts`，终态只写一次）四者分离；有效版本策略
（`EffectiveVersionPolicy = any | exact(X)`）在题库与「竞赛 ×
题目」两个作用域独立维护。

### 2. 内容事实源：草稿 + 版本，投影只是读缓存

- 每题一个**共享草稿** `problem_drafts`（`revision` 乐观锁：缺失 428 / 过时
  409）； 编辑、上传文件、增删客观题小题都递增同一个 revision。
- `POST /problems/:id/versions` 发布草稿为不可变版本（同内容重复发布返回
  `unchanged: true`，不制造空版本）；`problems.title/...` 仅由发布服务更新，
  是「最新版投影」，用于题库列表/搜索等既有读取。
- 未发布题目对普通访问者 404；编辑者经草稿接口读取。
- 全量导入（题包/CLI/演练）改为「写草稿 → 显式 publish」；`questions.json`
  支持可选 `key`（跨版本稳定，重判按 key 匹配旧答案，未提供则生成
  UUID，不按序号猜测）。
- OI 独立编辑路径（`saveOiDraft`）在同一草稿事务里切换「配置 + 逐文件引用 + 打包
  ZIP」， 陈旧 ZIP 由 `expectedRevision` 拒绝并补偿已上传对象。

### 3. 有效成绩物化：跨版本保留 + 双口径投影

`submission_version_results`
保存「某提交在某版本上的当前正式判定」（迁移历史允许 `problem_version_id = NULL`
的未知版本桶）；只有 `graded` 终态更新它。有效成绩由纯计算器 按策略选取：

- `any` 接受全部候选（含未知版本），`exact(X)` 只接受 X；
- `is_accepted`
  为「任一候选通过」，**通过指针与最高分指针分开**（不通过最高分反推通过）；
- 题库与竞赛各算一遍（`global_policy_revision` / `contest_policy_revision`），
  竞赛计分只读 `is_contest_valid` 的有效指针，排序仍用原始 `created_at`；
- 策略切换在事务提交后立即生效，不依赖物化视图刷新或缓存 TTL
  （`query_projection_revisions` + revision 键控 Redis
  缓存，视图落后时回退内联查询）。

### 4. 结果写入与协议 v2

`JudgeTask`/`JudgeResult` 增加 `evaluation_protocol_version = 2`、`attempt_id`、
`problem_version_id`、`run_id`（正式提交 `run_id = attempt_id`）与 `result_kind`
（`graded` / `platform_error`）。core 校验协议、尝试、版本、sequence、run_id
全部一致：
未知或不匹配的消息不写成绩；平台错误不替换已有正式判定，也不把「未通过」当成评测故障。
LLM 预算按 attempt 作用域（`llm:attempt:<id>:*`），重派共享额度，旧 token
吊销标记保留。

### 5. 管理操作：统一任务 + 可重试条目

单条重测、整题重测、整场重测与用户升级都走 `submission_jobs` /
`submission_job_items` （`FOR UPDATE SKIP LOCKED` 领取、lease
续租、指数退避、条目级 failed/skipped 与
`reason_code`）。重测目标三种：`submitted`（不可变提交时版本）/
`latest`（受理时固定）/ `specified`（逐题版本映射，界面「统一用
V3」在受理前展开，任一题缺该版本整次 400）。
用户升级生成**新提交**（沿用原用户、记录 `upgraded_from_id`、使用当前时间），
竞赛升级必须恰好等于固定版本。

### 6. 存量迁移与收尾

迁移链：`0102` 建表（三步式可空列）→ `0103` 基线 V1 + 既有结果转 `legacy_import`
尝试 → `0104` 重建 `user_rankings` 视图 → `0105` 删 `evaluation_results` →
`0106` 竞赛固定 版本回填 +
`SET NOT NULL`（未发布题目补迁移基线，空值直接报错中止）→ `0107` 删
`objective_questions`。迁移安全在真实存量数据上演练（独立 schema
复现迁移前状态后执行 迁移并核对回填/指针/约束）；`legacy_unknown`
历史卷面无法还原时保留未知状态， 按未作答处理，原始 answers 与既有成绩仍可读。

## Alternatives considered

- **只做「题目快照表」不分草稿/版本**：无法支撑「草稿不影响作答、相同内容不发新版本、
  发布要预检」的规则，也会让编辑流程没有乐观锁。
- **保留 `evaluation_results`
  与新表双写一段时间**：会长期存在两套成绩事实，读取路径容易
  再分叉；本次按「读路径全部迁离后立刻删表」收尾（0105/0107）。
- **`exact(X)` 下用最高分记录反推是否通过**：在「V2 高分不通过、V1
  通过」等场景会误判， 故通过指针与分数指针分开维护。
- **策略切换依赖物化视图刷新或 5 分钟
  TTL**：管理员切策略后必须立即生效，因此改为 revision 键控缓存 + 视图落后回退。
- **重测直接改写提交状态（旧语义）**：不可审计也不可重试；改为任务 + 条目后，
  进度、失败原因与重试都有持久化依据。

## Consequences

- 新增 12 张表与大量索引/约束，`problems` / 两类提交 / `contest_problems`
  增加版本与投影 字段；schema parity 收敛为 **66 表 / 594 列**。
- 客户端必须携带 `version_id`：老客户端会收到明确的升级提示而不是静默绑定新版；
  竞赛版本变化返回 `409 CONTEST_PROBLEM_VERSION_CHANGED`。
- 编辑流程从「保存即生效」变为「保存草稿 +
  显式发布两个动作」，管理端新增版本策略、 批量重测、任务进度页面。
- 交付为 core / judge / gateway / UI / IDE / CLI
  的**协调升级**，不支持新旧评测协议混跑；
  回滚必须使用升级前备份与同版本服务组合（不能只回退 core 二进制读新 schema）。
- 后续收紧项（已在实施跟踪中登记）：`resolveSubmissionVersion`
  对完全未发布的存量题目 仍回退 `legacy_unknown`；竞赛提交缺省 `version_id`
  的迁移期兼容；`acceptUpgradeJob` 尚无管理员旁路。
