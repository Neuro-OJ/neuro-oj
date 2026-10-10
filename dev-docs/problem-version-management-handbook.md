# Neuro OJ 题目版本管理实施 Handbook

## 1. 目标、术语与已确定的规则

本次交付包括数据模型、全部题型的版本化评测、有效成绩计算、管理员批量重测、用户批量升级、界面、现行文档及存量迁移。

### 1.1 四个独立概念

| 概念 | 定义 | 是否可变 |
|---|---|---|
| 题目身份 | 现有 `problems.id`、U/P 类型、题号、所有权等 | 按现有管理规则 |
| 题目版本 | 一份完整、已发布的作答与评测内容 | 发布后不可修改 |
| 提交时版本 | 用户创建提交时实际使用的题目版本 | 不可变 |
| 评测尝试 | 使用某个题目版本评测某条提交的一次执行 | 新增记录，终态结果不可覆盖 |
| 有效版本策略 | 当前统计接受哪些版本的成绩 | 管理员可显式修改 |

版本号在单题内递增，例如 P12 的 V3 与 P13 的 V3 是不同版本。数据库和 API 使用版本 UUID，数字版本号用于展示和批量选择。

### 1.2 题库与竞赛策略

```ts
type EffectiveVersionPolicy =
  | { mode: "any" }
  | { mode: "exact"; version_id: string };
```

- 默认 `any`：历史版本均可产生有效成绩。
- `exact(X)`：只采用 X 的成绩；X+1 不自动有效。
- 题库策略与每个“竞赛 × 题目”的策略独立。
- 发布新版本、重测指定版本、切换有效版本策略是三个独立动作。
- 策略切换在数据库事务提交后立即生效。
- 题库默认作答版本：`exact` 使用要求版本，`any` 使用最新版。
- 竞赛默认作答版本：使用该竞赛固定的题目版本。
- 竞赛采用 `exact(X)` 时，固定作答版本必须同时为 X。

### 1.3 跨版本成绩保留

一条提交可同时拥有 V1、V2 等版本的当前判定；每个版本只采用最近一次完成的正式判定。

| 操作 | V1 当前成绩 | V2 当前成绩 | `any` 下是否通过 | `exact(V2)` 下是否通过 |
|---|---:|---:|---:|---:|
| 初次提交 V1，通过 | AC | 无 | 是 | 否 |
| 发布 V2 | AC | 无 | 是 | 否 |
| 用 V2 重测，失败 | AC | WA | 是 | 否 |
| 再次用 V1 重测，失败 | WA | WA | 否 | 否 |
| 用 V2 重测，通过 | WA | AC | 是 | 是 |

基础设施错误不替换已有正式判定。正在重测时保留已有判定；切换策略后，已有判定是否继续有效由新策略决定。

### 1.4 题型名称与通过标准

| 展示名称 | 内部识别 | 通过标准 |
|---|---|---|
| OI 题 | `judge_type = oi` | OI verdict 为 AC |
| 代码题（AI） | dual、code、未启用 LLM | 沿用当前有效正分规则 |
| LLM 题（AI） | dual、code、启用 LLM | 沿用当前有效正分规则 |
| 产物提交题（AI） | dual、artifact | 沿用当前有效正分规则 |
| 客观题 | `is_objective = true` | 满分 |

产物提交题启用 LLM 时，主名称仍为“产物提交题（AI）”，另展示 LLM 能力标记。客观题可用于 AI 与 OI 场景，不新增 AI/OI 专属客观题枚举。

U/P 继续表示题库归属，不用于表示 AI/OI 题型。

---

## 2. 数据模型

### 2.1 通用约定

- 主键沿用项目风格：`text` 存储 UUID。
- 时间沿用规范化 ISO 8601 UTC 文本。
- 成绩沿用 ×100 整数，范围 `0..10000`。
- 新增枚举使用 TypeScript 字面量类型及数据库 CHECK。
- JSONB 均使用明确类型和服务端校验，不能接受未经校验的客户端对象。
- 版本与题目的关联使用复合外键，防止 P12 的提交引用 P13 的版本。
- 允许为空的历史版本字段必须表达真实未知状态，不能填入伪造版本。

### 2.2 扩展 `problems`

| 字段 | 类型 / 默认值 | 用途 |
|---|---|---|
| `latest_version_id` | text，可空 | 最新已发布版本；空表示尚未发布 |
| `effective_version_mode` | text，默认 `any` | 题库有效版本策略 |
| `required_version_id` | text，可空 | `exact` 要求版本 |
| `effective_policy_revision` | integer，默认 0 | 策略乐观锁及投影版本 |

约束：

- `any` 必须对应 `required_version_id IS NULL`。
- `exact` 必须对应非空要求版本。
- 最新版及要求版本必须属于该题。
- 当前 `title/description/runtime_config/...` 内容字段暂保留为“最新版投影”，仅由发布服务更新；草稿保存不更新这些字段。
- 所有作答、评测和历史查看改从版本记录读取，不能把最新版投影当成提交的评测来源。
- 难度、标签、所有权、可见性继续作为题目管理信息维护。

保留最新版投影是为了减少搜索、题目列表等既有读取的迁移风险；版本记录是内容事实来源。

### 2.3 新增 `problem_versions`

| 字段 | 类型 / 约束 |
|---|---|
| `id` | text，PK |
| `problem_id` | text，FK → problems |
| `version` | integer，≥1 |
| `schema_version` | integer，默认 1 |
| `origin` | `published` / `migration_baseline` |
| `content` | JSONB，完整 `ProblemContentV1` |
| `content_sha256` | text；新发布版本必填，迁移基线允许空 |
| `change_note` | text，默认空串 |
| `published_by` | text，可空，用户删除后 SET NULL |
| `published_at` | text，必填 |

索引与约束：

- UNIQUE `(problem_id, version)`。
- UNIQUE `(problem_id, id)`，供复合外键引用。
- INDEX `(problem_id, published_at)`。
- 数据库 UPDATE 守卫禁止修改已发布版本内容及元数据。
- 不提供修改或单独删除已发布版本的 HTTP API；整题删除走既有题目删除流程及关联清理。

版本内容定义：

```ts
type ProblemContentV1 = {
  title: string;
  description: string;
  samples: ProblemSample[];
} & (
  | {
      kind: "objective";
      questions: ObjectiveQuestionSnapshot[];
    }
  | {
      kind: "oi";
      runtime_config: OiRuntimeConfig;
    }
  | {
      kind: "ai";
      submission_mode: "code" | "artifact";
      runtime_config: RuntimeConfig;
      template_content: string;
      artifact_max_size_mb: number | null;
      llm_config: LlmConfig | null;
    }
);
```

注意：

- 支持包和 OI 文件引用放入独立文件表，避免仅藏在 JSON 中而被存储审计遗漏。
- 首次发布后固定 `kind`，AI 题同时固定 `submission_mode`。跨 AI/OI、客观题/编程题或 code/artifact 的转换通过新建题目完成。
- AI 代码题启用或关闭 LLM 可以形成新版本。
- OI 的 native/WASM 后端、测试点、子任务、checker、语言列表等随版本保存。
- 平台安全限制、镜像白名单、WASM 可信计时标准和 LLM 平台默认服务仍采用现行平台规则；每次实际执行的取值记录在评测尝试中。

### 2.4 新增 `problem_drafts`

| 字段 | 类型 / 约束 |
|---|---|
| `problem_id` | text，PK / FK → problems |
| `base_version_id` | text，可空，必须属于该题 |
| `revision` | integer，默认 1 |
| `content` | JSONB，草稿内容 |
| `updated_by` | text，可空 |
| `updated_at` | text，必填 |

规则：

- 每题一个共享草稿，权限沿用题目编辑权限。
- 草稿可暂时缺少支持包、完整运行配置或客观题小题；发布时必须完整。
- 编辑、上传文件、增删客观题小题均递增同一个 `revision`。
- 所有修改必须校验预期 revision。
- 发布成功后保留草稿，将其基线更新为刚发布版本并递增 revision。
- 相同完整内容重复发布返回 `unchanged: true` 和现有版本，不制造空版本。
- 内容哈希覆盖规范化内容与按路径排序的文件哈希；不包含发布说明、操作者或时间。

### 2.5 文件与存储引用

新增三张表：

| 表 | 主要字段 | 用途 |
|---|---|---|
| `storage_objects` | `storage_url` PK、`sha256`、`byte_size`、`state`、`created_at` | 对象登记与删除互斥 |
| `problem_draft_objects` | `problem_id` FK、`role`、`path`、`storage_url` FK | 草稿文件引用 |
| `problem_version_objects` | `version_id` FK、`role`、`path`、`storage_url` FK | 发布版本文件引用 |

具体规则：

- `role = support_package | oi_file`。
- UNIQUE `(problem_id, role, path)` 和 `(version_id, role, path)`。
- 完整支持包使用固定逻辑路径 `package.zip`；OI 文件使用现有规范化相对路径。
- `storage_objects.state = unknown | ready | missing | deleting | deleted`。
- 新对象登记为 `ready`；存量对象登记为 `unknown`，首次预检或使用时核实。
- 文件大小和哈希由服务端存储流程产生，客户端不能注入对象引用。
- 发布时复制引用，不复制文件字节；草稿后续替换引用不影响历史版本。
- 新产物提交保留对象直到提交显式删除，不设置自动过期时间。
- 删除对象必须锁定登记行、检查全部引用，再进入 `deleting`；新引用不能绑定 `deleting/deleted` 对象。
- 本地内容寻址可能返回共享对象。上传补偿不能直接调用 `storage.delete()` 删除已被其他记录引用的文件。

增加 `StorageProvider.stat(url)`：local 使用文件元数据，S3 使用对象元数据查询，用于确认存在性和大小。

### 2.6 扩展 `contest_problems`

| 字段 | 类型 / 默认值 |
|---|---|
| `pinned_version_id` | text，必填 |
| `effective_version_mode` | text，默认 `any` |
| `required_version_id` | text，可空 |
| `effective_policy_revision` | integer，默认 0 |

约束：

- 固定版本与要求版本必须属于关联题目。
- `exact` 时要求版本必须等于固定版本。
- 添加题目时固定当时最新已发布版本，未发布题目不能加入竞赛。
- 升级固定版本本身不撤销旧成绩；是否撤销由有效策略决定。
- 保存竞赛题目列表时，未改变的关联必须保留固定版本与策略，不能重新绑定最新版。

### 2.7 扩展两类正式提交

普通提交和客观题提交均增加以下字段：

| 字段 | 类型 / 默认值 |
|---|---|
| `submitted_version_id` | text，可空，复合 FK |
| `version_origin` | `known` / `legacy_unknown` |
| `upgraded_from_id` | text，可空，同类提交 FK，删除来源后 SET NULL |
| `active_attempt_id` | text，可空 |
| `latest_attempt_id` | text，可空 |
| `is_valid` | boolean，默认 false |
| `is_accepted` | boolean，默认 false |
| `effective_attempt_id` | text，可空 |
| `accepted_attempt_id` | text，可空 |
| `is_contest_valid` | boolean，默认 false |
| `is_contest_accepted` | boolean，默认 false |
| `contest_effective_attempt_id` | text，可空 |
| `contest_accepted_attempt_id` | text，可空 |
| `global_policy_revision` | integer，默认 0 |
| `contest_policy_revision` | integer，可空 |

普通提交沿用 `rejudge_seq`；客观题增加同名字段，默认 0。

规则：

- `known` 必须有提交时版本，`legacy_unknown` 必须为空。
- 创建后禁止修改 `submitted_version_id` 和 `version_origin`。
- 重测只改变评测尝试，不改变原始代码、答案、产物、提交时间和来源版本。
- 客观题原始 `answers` 不随重测改写。
- 客观题竞赛一次性提交唯一约束保留。
- `active_attempt_id` 表示在途任务，`latest_attempt_id` 表示最近一次终态尝试；它们不能替代有效成绩指针。
- 新增 `(problem_id, is_accepted, user_id)` 等有效状态查询索引；竞赛增加 `(contest_id, problem_id, is_contest_valid, user_id)` 索引。
- 自测增加版本 ID 和恢复所需任务快照，继续与正式提交统计隔离。

### 2.8 新增 `evaluation_attempts`

统一保存普通题与客观题的评测历史。

| 字段 | 类型 / 约束 |
|---|---|
| `id` | text，PK，同时作为正式评测 `run_id` |
| `submission_id` | text，可空，FK |
| `objective_submission_id` | text，可空，FK |
| `problem_id` | text，必填 |
| `problem_version_id` | text，可空；仅迁移历史允许空 |
| `sequence` | integer，≥0 |
| `source` | `initial` / `rejudge` / `upgrade` / `legacy_import` |
| `state` | `queued` / `judging` / `finished` / `error` / `superseded` |
| `result_kind` | 可空，`graded` / `platform_error` |
| `result_status` | text，可空 |
| `score` | integer，可空 |
| `accepted` | boolean，默认 false |
| `output` | text，默认空串 |
| `details` | JSONB，默认空对象 |
| `time_ms` / `memory_kb` | integer，可空 |
| `task_snapshot` | JSONB，可空 |
| `created_by` | text，可空 |
| `created_at` / `started_at` / `finished_at` | text，后两者可空 |

约束与索引：

- 两个提交外键恰好一个非空。
- 分别 UNIQUE `(submission_id, sequence)`、`(objective_submission_id, sequence)`。
- INDEX `(submission_id, problem_version_id, sequence DESC)`；客观题同样建立。
- INDEX `(state, created_at)`。
- 尝试的题目、版本、源提交必须一致，由唯一写入服务检查。
- 终态只可写入一次，重复回调不覆盖结果。

`task_snapshot` 保存实际执行配置、语言、版本、平台计时标准、LLM Provider/模型和已解析预算。存储对象使用稳定引用；不持久化可用 token、Provider Key 或临时签名下载 URL。

### 2.9 新增 `submission_version_results`

该表保存“某提交在某版本上的当前正式判定”。

字段：

```text
id
submission_id / objective_submission_id  恰好一个非空
problem_id
problem_version_id                      迁移历史允许空
current_attempt_id                      FK → evaluation_attempts
updated_at
```

唯一索引分别覆盖：

- 普通提交的已知版本 `(submission_id, problem_version_id)`。
- 客观题提交的已知版本 `(objective_submission_id, problem_version_id)`。
- 普通提交的未知版本桶 `(submission_id)`。
- 客观题提交的未知版本桶 `(objective_submission_id)`。

上述索引均使用对应非空来源及版本条件的 partial index。

只有 `graded` 尝试更新此表。平台错误、在途尝试、过时尝试不更新它。指针必须指向相同提交、题目和版本的已完成正式判定。

### 2.10 新增批量任务表

`submission_jobs`：

```text
id
kind                     rejudge / upgrade
actor_id
idempotency_key
request_hash
request                  JSONB，规范化请求及固定版本映射
status                   queued / running / completed / completed_with_errors
created_at / finished_at
```

UNIQUE `(actor_id, kind, idempotency_key)`。

`submission_job_items`：

```text
id
job_id                   FK
ordinal
source_kind              submission / objective
source_id                原始引用文本，保留删除后的任务记录
problem_id
target_version_id        FK，可空
target_version_ref       原始版本 ID，用于历史记录
status                   pending / preparing / dispatched / succeeded / failed / skipped
attempt_id               可空
result_submission_id     升级生成的新提交，可空
lease_owner / lease_until
dispatch_retries
next_dispatch_at
reason_code / reason_message
created_at / finished_at
```

- UNIQUE `(job_id, source_kind, source_id)`。
- INDEX `(status, next_dispatch_at, lease_until)`。
- INDEX `(job_id, status)`。
- 删除目标版本或题目时，任务保留原始引用及说明。
- 任务计数从条目聚合，不另维护进程内计数器。

---

## 3. 有效成绩计算算法

### 3.1 唯一计算入口

新增纯计算器及事务写入服务，分别负责：

```ts
selectEffectiveResults(currentResults, policy)
recomputeSubmissionProjection(tx, source)
recomputeProblemProjections(tx, problemId)
recomputeContestProblemProjections(tx, contestId, problemId)
```

跨域通过门面导出调用。共享层只放纯类型、判定函数及 SQL 谓词，不反向引用业务域。

### 3.2 候选集与选取规则

对每条提交：

1. 读取 `submission_version_results` 指向的当前正式判定。
2. `any` 接受全部候选，包括迁移的未知版本成绩。
3. `exact(X)` 只接受 `problem_version_id = X`，未知成绩不匹配。
4. 有候选则 `is_valid = true`。
5. 候选中任一 `accepted = true`，则 `is_accepted = true`。
6. 有效成绩指针选择最高分候选；同分按尝试 sequence 升序、ID 升序稳定选择。
7. 通过成绩指针选择通过候选中 sequence 最小的记录。
8. 无候选时两个布尔值为 false，两个指针为空。

题库及竞赛分别执行该算法。因此通过成绩指针可能与最高分成绩指针不同，不通过最高分反推“是否通过”。

### 3.3 判定与平台错误

Judge 增加明确的 `result_kind`：

- OI：AC、WA、TLE、MLE、OLE、RE、CE 等正式 verdict 属于 `graded`；SE 属于 `platform_error`。
- AI：正常完成评分，包括零分，属于 `graded`；既有明确归因的用户超时等属于零分正式判定。
- 支持包缺失、镜像或容器启动失败、内部异常、无法取得合法评分结果属于 `platform_error`。
- 客观题成功执行判卷属于 `graded`；服务异常属于平台错误。

沿用现有超时归因，不借本次改动重新定义题型评测语义。分类由 Judge 的结果构造入口产生，不能通过前端传参或解析输出文本猜测。

### 3.4 统计与时间语义

- 一条提交即使在多个版本上评测，也只计一次提交。
- 用户升级生成新提交，因此增加提交数。
- 用户通过题数对题目 ID 去重。
- 竞赛最佳成绩仅使用 `is_contest_valid` 的有效成绩指针。
- 竞赛排序及成绩归属使用原始 `submission.created_at`，重测时间不把旧提交变成赛后提交。
- 升级的新提交使用当前时间。
- 公开通过率分母使用当前有效、已产生正式判定的提交数；另返回实际总提交数。
- `total_submissions` 表示实际提交数；`valid_submissions` 表示当前口径有效数。
- 保留竞赛的赛期、封榜、`affect_global_ranking` 和可见性过滤。这些读取条件独立于版本有效属性，不能因为 `is_valid = true` 就公开成绩。

### 3.5 缓存和物化视图

新增 `query_projection_revisions`：

```text
scope_key               PK，例如 global、problem:<id>、contest:<id>
data_revision           bigint，默认 0
materialized_revision   bigint，默认 0
```

- 判定替换与策略切换在业务事务中递增相关 `data_revision`。
- Redis 缓存键包含 revision，读取时从 DB 获取当前 revision。
- 用户榜单物化视图落后时，使用已存在的内联查询路径。
- 刷新使用数据库 advisory lock 串行执行；刷新后记录其覆盖的 revision。
- 刷新期间有新变化则继续视为落后，不能把旧视图标为最新。
- 删除现有相关统计的进程内缓存及增量计数依赖，改为 revision 对应的数据库聚合与 Redis 缓存。
- 策略立即生效不能依赖五分钟 TTL 或异步视图刷新完成。

---

## 4. API 契约

所有路径以 `/api/v1` 为前缀。新增接口使用现有错误体系、RBAC、分页和 actor/audit 机制。

### 4.1 草稿、版本和题目读取

| 接口 | 行为 |
|---|---|
| `GET /problems/:id/draft` | 编辑者读取共享草稿及 revision；没有草稿时返回基于最新版的编辑初值 |
| `PUT /problems/:id/draft` | 保存草稿，要求 `If-Match: revision` |
| `GET /problems/:id/draft/preflight` | 对当前 revision 执行发布预检 |
| `POST /problems/:id/versions` | 发布草稿，要求 `If-Match` |
| `GET /problems/:id/versions` | 分页返回已发布版本元数据 |
| `GET /problems/:id/versions/:versionId` | 返回经过权限裁剪的指定版本 |
| `GET /problems/:id?version_id=...` | 显式读取该版本 |
| `GET /problems/:id` | 返回默认作答版本 |

发布请求：

```json
{
  "change_note": "补充边界测试数据"
}
```

发布响应至少包含：

```json
{
  "data": {
    "problem_id": "...",
    "version_id": "...",
    "version": 3,
    "draft_revision": 8,
    "unchanged": false
  }
}
```

读取题目响应增加：

```text
version_id
version
latest_version_id
latest_version
effective_version_policy
is_latest
```

- 草稿写入缺少预期 revision 返回 428；过时返回 409。
- 未发布题目对普通访问者返回 404，编辑者通过草稿接口读取。
- 历史版本遵循题目当前访问权限与竞赛保密规则，不能因选择旧版本绕过保密。
- 用户响应不包含支持包存储位置、隐藏数据或客观题答案。

### 4.2 新提交

普通代码、artifact、客观题及自测均携带 `version_id`：

- 普通提交、客观题使用 JSON 字段。
- artifact 使用 multipart 字段。
- 自测请求新增同名字段。
- 服务端校验版本属于该题且已发布。
- 题库允许显式提交其他已发布版本，返回其当前有效性。
- 竞赛只接受固定版本，不接受客户端覆盖。
- 竞赛版本已变更时返回 `409 CONTEST_PROBLEM_VERSION_CHANGED`，保留客户端代码或答案并要求刷新。
- 新客户端必须携带版本。老客户端缺少字段时返回明确升级提示，不静默绑定新版。

### 4.3 管理员重测任务

```http
POST /admin/submission-jobs
Idempotency-Key: <UUID>
```

```ts
type RejudgeRequest = {
  kind: "rejudge";
  scope:
    | {
        type: "selected";
        submissions: Array<{
          kind: "submission" | "objective";
          id: string;
        }>;
      }
    | { type: "problem"; problem_id: string }
    | { type: "contest"; contest_id: string };

  target:
    | { mode: "submitted" }
    | { mode: "latest" }
    | { mode: "specified"; versions: Record<string, string> };

  policy_changes?: Array<{
    problem_id: string;
    contest_id?: string;
    expected_revision: number;
    policy: EffectiveVersionPolicy;
  }>;
};
```

语义：

- `submitted` 使用不可变提交时版本，不使用最近评测版本。
- `latest` 在受理事务中解析并固定每题最新版。
- `specified.versions` 为题目 ID → 版本 ID 映射。
- 界面的“全部用 V3”先将 V3 展开为逐题版本映射；任一题没有 V3，整次受理返回 400。
- `policy_changes` 为空表示不改变有效策略。
- 策略变更必须显式列出作用域和预期 revision，且只能作用于任务包含的题目或竞赛。
- 受理时同时固定提交集合，之后产生的新提交不进入本批任务。
- 手动所选提交数量上限 500；整题和整场任务没有 500 条总量限制，后台分批执行。
- 接口返回 `202` 和任务 ID；空集合返回已完成、总数为 0 的任务。

任务接口：

```text
GET  /admin/submission-jobs/:id
GET  /admin/submission-jobs/:id/items
POST /admin/submission-jobs/:id/retry
```

重试生成关联新任务，保留目标版本映射，不再次修改有效策略。

现有单提交、整题重测接口保留为入口适配层，默认目标为 `submitted`，调用统一任务服务并返回任务 ID。

### 4.4 用户升级任务

```http
POST /submission-upgrade-jobs
Idempotency-Key: <UUID>
```

```json
{
  "submissions": [
    { "kind": "submission", "id": "..." },
    { "kind": "objective", "id": "..." }
  ],
  "context": "practice"
}
```

- 单次最多 500 条。
- `context = practice | source_contest`，默认 practice。
- 最新版在受理时固定。
- 新提交沿用原用户，记录升级来源，使用当前提交时间。
- 用户只可升级自己的提交；管理员可通过管理入口为原用户执行升级。
- 升级仍执行正常提交权限、速率、大小及竞赛限制。
- 选择 `source_contest` 时，新版必须恰好为固定竞赛版本。
- 客观题竞赛已有提交时，仍不能产生第二次提交；用户可升级为练习提交，管理员可以重测原提交。
- 不自动把失败的竞赛升级改成练习提交。
- 重复 Idempotency-Key 和相同请求返回原任务；不同请求返回 409。

用户只能读取自己的升级任务，管理员可以读取所有任务。

### 4.5 有效策略与竞赛固定版本

```text
PUT /admin/problems/:id/effective-version-policy
PUT /admin/contests/:contestId/problems/:problemId/effective-version-policy
PUT /admin/contests/:contestId/problems/:problemId/version
```

- 前两者要求预期策略 revision。
- 竞赛 exact 策略同时固定作答版本。
- 单独升级固定版本时，可同时提交新策略；若现有 exact 策略与目标固定版本冲突，返回 409。
- 题库 exact 不修改最新版指针，默认作答版本由解析器选择。
- 策略响应返回新 revision 与受影响提交数量。

---

## 5. 事务、状态机与执行流程

### 5.1 固定锁顺序

需要多个锁时遵循：

1. 按 ID 排序的题目行。
2. 按 ID 排序的竞赛行。
3. 对应两类提交行。
4. 评测尝试及当前判定行。
5. 投影 revision 行。

普通结果写入对题目和竞赛取共享锁，对提交取更新锁；策略修改对相关策略宿主取更新锁。策略重算必须与结果写入互斥，防止旧策略投影覆盖新策略。

批任务领取使用独立短事务，领取后再按上述顺序执行业务事务，不持有条目领取事务等待外部 IO。

### 5.2 保存草稿

1. 校验题目编辑权限及敏感评测字段权限。
2. 校验预期 revision。
3. 上传新对象并登记；复用内容相同的旧对象。
4. 事务中替换草稿内容与文件引用，递增 revision。
5. 事务失败后对上传对象执行引用检查；共享对象不得误删。
6. 草稿保存不推送 Judge、不改有效策略、不刷新公开题目内容。

草稿中的部分配置可未完成，但路径安全、ZIP 限额和敏感字段权限必须立即检查。

### 5.3 发布版本

1. 读取草稿及文件引用，执行完整预检。
2. 事务锁定题目、草稿，再次检查 revision 和基线。
3. 确认草稿基线仍是最新版；其他人已发布则返回 409。
4. 检查题型和提交模式不可变约束。
5. 检查对象状态、OI 配置引用文件、客观题答案和运行配置。
6. 计算内容哈希；相同内容返回现有版本。
7. 分配下一个版本号，插入内容及不可变文件引用。
8. 更新最新版指针、现有最新版投影和草稿基线。
9. 写审计与持久化事件，提交后通知搜索重新索引。

文件预检与锁内确认必须绑定同一草稿 revision，不能检查 A 草稿却发布 B 草稿。

### 5.4 创建提交或重测尝试

1. 解析明确目标版本，检查提交模式、语言与当前平台安全规则。
2. 预检支持包、产物及 LLM 服务，准备非敏感执行快照。
3. 事务锁定提交，确认没有活动尝试。
4. 创建尝试；重测递增 sequence，新提交初次 sequence 为 0。
5. 设置 `active_attempt_id` 和运行状态。
6. 保留已有分版本判定及有效成绩。
7. 持久化待派发状态，提交后执行 MQ 派发。

所有配置和恢复来源均是尝试绑定的版本与任务快照，不能重新调用当前题目的最新版配置构造任务。

### 5.5 消息协议

正式 JudgeTask / JudgeResult 增加：

```text
evaluation_protocol_version = 2
attempt_id
problem_version_id
run_id
result_kind                 结果字段
```

- 正式提交 `run_id = attempt_id`。
- 保留 `submission_id` 与 `rejudge_seq`。
- 自测使用独立运行标识，同样携带版本和协议版本。
- core 校验协议、尝试、版本、sequence、run_id 全部一致。
- 未知或不匹配消息不能写成绩。
- 协议字段置于可信结果封套，不放入可由 evaluator 自定义的 `details`。

### 5.6 结果落库

在同一事务中：

1. 锁定并读取提交当前活动尝试。
2. 忽略已处理、过时或不匹配结果。
3. 执行现有分数、状态、details 防御性校验。
4. 写尝试终态。
5. 若为 graded，更新对应版本的当前判定指针。
6. 按当前题库及竞赛策略重算全部有效字段。
7. 清空活动尝试，更新最近尝试和运行状态。
8. 完成对应任务条目，递增聚合 revision。
9. 写持久化 SSE 事件。

提交后吊销本次 token、发布 SSE，并调度派生查询刷新。重复消息不能重复计数或再次生成升级提交。

### 5.7 后台批任务

- worker 从 `submission_job_items` 使用 `FOR UPDATE SKIP LOCKED` 领取。
- 默认每次领取最多 100 条，lease 60 秒，执行期间续租。
- worker 在 `main()` 后台消费者启动阶段注册，并接入现有关闭流程。
- 队列容量不足等待下轮，不计作派发失败。
- 网络派发失败使用最多 5 次指数退避：1、2、4、8、16 秒。
- 崩溃后 lease 到期可重新领取；相同尝试允许重复派发，结果只应用一次。
- 结果比“已派发”状态更新更早到达时，后续派发更新不能把终态改回 judging。
- 真正超时且需要新执行时创建新尝试、递增 sequence，旧尝试标记 superseded。
- MQ URL 和 token 在派发时生成；重派可以重新生成交付凭据，但不更改目标版本或已固定服务配置。
- WA、零分等属于任务成功完成；平台错误属于条目 failed。
- 活动提交属于 skipped；不整批拒绝。
- 重试只包含 failed/skipped 条目，执行前重新检查提交是否仍符合条件。
- job 状态与统计由持久化条目推导，全部终态后结束。

---

## 6. 各功能修改入口

### 6.1 Schema 与测试数据库

修改：

- [catalog.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema/catalog.ts)：题目版本、草稿、文件引用及题目新增字段。
- [submission.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema/submission.ts)：普通提交属性、尝试、分版本判定、任务表。
- [objective.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema/objective.ts)：客观题提交版本及投影属性。
- [contest.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema/contest.ts)：固定用题版本与策略。
- [system.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema/system.ts)：存储对象登记。
- [schema-ddl.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/shared/db/schema-ddl.ts)：同步 PGlite 表、约束和索引。

query revision 表归 query 域所有，schema 中单独定义并从 schema 入口导出。更新表所有权文档。

循环外键按项目 Drizzle 风格使用延迟类型引用；迁移先建表，再添加关联外键。

### 6.2 Catalog：内容版本与发布

在 [catalog 服务目录](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services) 新增版本、草稿和发布服务。

现有入口改动：

| 入口 | 修改 |
|---|---|
| [problems-crud.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/problems/problems-crud.ts) | create 创建身份与草稿；内容更新写草稿；管理信息更新独立处理；删除补齐引用清理 |
| [problems-list.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/problems/problems-list.ts) | 公共列表排除未发布题目；默认内容版本解析；通过状态改读投影 |
| [problem-resolve.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/problem-resolve.ts) | 分开身份解析、版本解析与内容投影；权限仍对题目身份执行 |
| [problem-bundle.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/problems/problem-bundle.ts) | 统一导入写草稿；显式 publish；停止删除旧版本包及全量覆盖已发布客观题 |
| [support-package.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/support-package.ts) | 上传、移除修改草稿引用；历史下载绑定版本；模板从版本读取 |
| [problems 路由](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/routes/problems.ts) | 新草稿与版本接口；既有内容更新转草稿；全部提交传版本 |
| [admin catalog 路由](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/admin/routes/catalog.ts) | 预检读取草稿；管理信息更新与内容编辑分开 |

题包 `format_version` 保持 1。题目内容版本与题包格式版本是不同概念。

### 6.3 OI 独立编辑路径

修改 [oi-data.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/oi-data.ts)、[oi-author.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/routes/oi-author.ts) 和 [oi-self-test-package.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/oi-self-test-package.ts)。

必须处理：

- `saveOiMetadata()`、`saveOiData()` 写草稿，使用 draft revision。
- 逐文件索引与打包 ZIP 在同一次草稿事务中切换。
- `loadOiData()` 显式接受 draft 或 version 来源，不能默认读 `problems.oi_data_files`。
- metadata-only 保存复用草稿文件引用，并检查新配置引用的路径。
- ZIP worker 的结果绑定 revision；完成时草稿已变化则拒绝覆盖。
- 发布保存完整包及逐文件引用。
- OI 自测从所选版本构造临时包，并登记临时对象引用。
- native/WASM 切换、语言删减、SPJ 修改均进入新版本。

### 6.4 Objective：快照与重判

修改：

- [objective-questions.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/objective/services/objective-questions.ts)。
- [objective-submissions.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/objective/services/objective-submissions.ts)。
- [objective-judge.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/objective/services/objective-judge.ts)。

实现规则：

- 小题保存到草稿 content；已发布小题从版本快照读取。
- 小题 `key` 在同题跨版本稳定。现有 API 的 `id` 返回该 key。
- 迁移时采用现有小题 UUID 作为 key。
- Web 修改保留 key，新增小题生成 UUID。
- `questions.json` 支持可选 `key`；重复 key 拒绝；未提供时生成新 key。
- 导入不会按序号或题干猜测旧小题对应关系。
- 标识按题目作用域解释，不接受其他题目内容引用。
- 重判按目标版本 key 匹配原答案；新增或不匹配小题按未作答；删除小题不计分。
- 目标题型不接受旧答案形式时按未作答；原始 answers 保留不变。
- 详情记录匹配/缺失/形式不兼容，仍执行答案与解析裁剪。
- 客观题创建提交及重判都通过统一尝试和投影写入服务。
- 最终移除 `objective_questions` 作为运行期事实来源；迁移完成并适配全部读取后删除旧表。

### 6.5 Submission：创建、重测、历史与恢复

修改：

- [submissions-crud.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/submissions/submissions-crud.ts)：明确版本创建，分别返回最近运行与有效成绩。
- [artifact-submissions.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/submissions/artifact-submissions.ts)：对象登记、持久保留、共享升级、目标版本大小校验。
- [submissions-rejudge.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/submissions/submissions-rejudge.ts)：改为统一任务受理，移除当前题配置重测和总量 500 限制。
- [submissions-result.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/submissions/submissions-result.ts)：尝试终态、当前版本判定、双口径投影事务；停止评测后删除产物。
- [prepare-judge-task.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/prepare-judge-task.ts)：接收持久化 attempt/run_id，不在重建任务时重新生成运行标识。
- [sweeper.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/mq/sweeper.ts)：从尝试快照恢复；移除产物 pending 自动清理导致不可恢复的路径。
- [submission-projection.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/submission/services/submissions/submission-projection.ts)：对最近结果、有效结果及全部历史应用相同权限裁剪。

新增任务 worker、升级服务、投影计算服务及历史查询服务，并通过 submission 门面导出。

`evaluation_results` 的所有运行期读取迁移至有效尝试或最近尝试后，完成历史回填并删除旧表，避免长期存在两套成绩事实。

### 6.6 Contest、Query、Identity、Community、Search

| 模块 | 必须修改的入口与行为 |
|---|---|
| Contest | [contests.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/contest/services/contests.ts)：添加题目固定版本，列表编辑保留绑定 |
| Contest | [contest-ranking.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/contest/services/contest-ranking.ts)：有效指针计分、结算检查新任务、正式快照记录版本与尝试 |
| Query | [rankings.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/query/services/rankings.ts)、[stats-cache.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/query/services/stats-cache.ts)、[dashboard.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/query/services/dashboard.ts)：双类提交统一聚合，revision 缓存及视图回退 |
| Catalog | [trainings.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/trainings.ts)、[problems-stats.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/catalog/services/problems/problems-stats.ts)：进度和有效统计 |
| Identity | [users-profile-queries.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/identity/services/users/users-profile-queries.ts)：用户通过数、通过列表、通过率 |
| Community | [community-post-common.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/community/services/community/community-post-common.ts)：题解门槛统一读取有效通过 |
| Search | [index-writer.ts](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/search/services/index-writer.ts)：发布后索引公开版本，草稿不入公开索引 |

正式成绩发布要在同一一致性事务中读取结算条件、策略与榜单，并记录每题版本策略、有效尝试及提交时间。既有成绩快照保留，修订通过新快照发布。

结算必须区分正常 WA/零分和平台失败，不能把未通过等同于评测故障。

### 6.7 Judge 与 LLM Gateway

修改 [Judge types](/home/xyber-nova/Github/neuro-oj/noj-judge/src/types.rs)、[Judge runner](/home/xyber-nova/Github/neuro-oj/noj-judge/src/judge/runner.rs)、[dual](/home/xyber-nova/Github/neuro-oj/noj-judge/src/dual/mod.rs)、[OI](/home/xyber-nova/Github/neuro-oj/noj-judge/src/oi/mod.rs)。

- 全部成功、失败、超时构造入口透传版本与尝试标识。
- Rust 与 TypeScript 的任务字段、结果字段及契约夹具同步。
- 支持包缓存继续采用 SHA-256 内容寻址。
- OI 进度事件包含当前 run_id，旧进度不能写入新尝试。

LLM 修改 [core token 服务](/home/xyber-nova/Github/neuro-oj/noj-core/src/domains/gateway/services/llm-token.ts) 与 [gateway 模块](/home/xyber-nova/Github/neuro-oj/noj-llm-gateway/src)：

- token 增加 `attempt_id`、`problem_version_id` 和 token 协议版本。
- 单次额度键改为 `llm:attempt:<attempt_id>:calls/tokens/cost`。
- 吊销键改为 `llm:attempt:revoked:<attempt_id>`；重测创建新 attempt，不删除旧吊销标记。
- 同一尝试重派共享额度，不能通过重新签发 token 重置额度。
- 用户、题目、全局日/月额度继续跨尝试累计。
- `llm_usage` 增加可空 attempt/version 字段，历史记录保留未知值。
- 实际 Provider、模型与解析预算绑定本次尝试；服务停用时报告失败，不静默换服务。
- 重测前置预检保留；Provider 缺配不能让提交无任务地卡在 pending。

### 6.8 UI、IDE 与 CLI

| 入口 | 修改 |
|---|---|
| [编辑器目录](/home/xyber-nova/Github/neuro-oj/noj-ui/components/editor) | OI/AI 编辑统一草稿 revision；保存草稿、发布版本两个动作 |
| [客观题编辑器](/home/xyber-nova/Github/neuro-oj/noj-ui/components/objective/ObjectiveProblemEditor.vue) | 小题编辑写草稿，稳定 key，整卷发布 |
| [题目详情](/home/xyber-nova/Github/neuro-oj/noj-ui/pages/problems/[id].vue) | 版本选择、最新版提示、当前通过要求、提交携带版本 |
| [竞赛题目页](/home/xyber-nova/Github/neuro-oj/noj-ui/pages/contests/[contestId]/problems/[label].vue) | 固定版本作答，版本冲突保留编辑内容 |
| [提交列表](/home/xyber-nova/Github/neuro-oj/noj-ui/pages/submissions/index.vue) | 版本及有效性筛选、批量升级 |
| [提交详情](/home/xyber-nova/Github/neuro-oj/noj-ui/pages/submissions/[id].vue) | 提交时版本、来源关联、最近运行、各版本当前判定、历史 |
| [管理页面目录](/home/xyber-nova/Github/neuro-oj/noj-ui/pages/admin) | 三种重测范围、固定版本映射、独立策略切换、任务进度 |
| [composables](/home/xyber-nova/Github/neuro-oj/noj-ui/composables) | 版本/任务 API、幂等键、终态轮询和 SSE 后重取数据 |
| [LMCC extension](/home/xyber-nova/Github/neuro-oj/noj-lmcc-extension/src) | 类型、题目选择状态、提交 API 保存并发送选定版本 |
| [core CLI](/home/xyber-nova/Github/neuro-oj/noj-core/scripts/noj.ts) | `problems import --publish`；开发初始化显式发布 |
| [生产演练](/home/xyber-nova/Github/neuro-oj/noj-cli/src/prod/drill/verify.ts) | 演练导入明确发布，否则后续提交会访问未发布题目 |
| [CLI 题包目录](/home/xyber-nova/Github/neuro-oj/noj-cli/src/problem) | 小题 key 的 lint/pack/契约及 vendor 校验同步 |

SSE 不广播其他用户的尝试详情或题目答案。任务 SSE 仅向操作者及有权限的管理员提供。

新增控件沿用现有 `useApi`、管理组件和品牌 token，数值使用 `tabular-nums`。

---

## 7. 必须显式处理的边界

| 情景 | 固定处理规则 |
|---|---|
| 发布期间有人提交 | 用户携带明确版本；该版本仍存在且可访问则按它创建 |
| 竞赛固定版本已变化 | 旧客户端提交返回 409，不自动换版 |
| 同时发布同一草稿 | 一个成功，另一个 revision/基线冲突 |
| 策略切换与结果回写并发 | 锁策略宿主，结果按事务读取的当前策略重算 |
| 重测旧版期间发布新版 | 任务目标版本不变 |
| 整场“统一 V3”，某题无 V3 | 受理失败，不产生任务或策略修改 |
| 按提交时版本重测未知历史提交 | 条目 skipped，`LEGACY_VERSION_UNKNOWN` |
| 旧产物已被删除 | 条目 failed，`ARTIFACT_MISSING`，保留已有成绩 |
| 原语言不在目标版本允许列表 | 条目 failed，`LANGUAGE_NOT_SUPPORTED` |
| 原产物超出新版大小限制 | 条目 failed，`ARTIFACT_TOO_LARGE_FOR_VERSION` |
| 目标配置违反现行平台安全限制 | 条目 failed，保留历史判定 |
| 源提交正在评测 | skipped，允许之后重试 |
| 原提交已在最新版，用户仍升级 | skipped，`ALREADY_LATEST`；再次评测使用管理员重测 |
| 同一提交重复出现在批量请求 | 受理时去重，只生成一个条目 |
| 提交删除后任务开始处理 | skipped，`SOURCE_DELETED` |
| 已发布版本不可访问 | 用户升级按现有权限失败，不泄露版本内容 |
| 用户跨版本升级失败 | 原提交和原成绩保持可读 |
| 重测成功但答案仍错 | 条目 succeeded；成绩是不通过 |
| exact X 下 X 的执行平台失败 | 旧 X 正式判定保留；此前无 X 判定则继续无有效成绩 |
| 赛后重测 | 使用原提交时间计入原比赛，不放宽新提交窗口 |
| 已发布正式成绩 | 实时成绩可变，正式快照通过显式修订更新 |

删除提交或整题沿用现有授权和业务语义，但拒绝删除正在执行的尝试；补齐新表清理顺序。批任务保留原始引用用于解释已删除条目。物理存储删除统一经过引用守卫。

---

## 8. 存量迁移、文档与上线

### 8.1 迁移顺序

1. 通过 `deno task db:generate` 生成新增表、可空字段及约束的迁移。
2. 为每道现有题目创建 `migration_baseline` V1：
   - 当前题面、样例、配置与模板；
   - 当前客观题小题，UUID 作为稳定 key；
   - 当前支持包和 OI 逐文件引用。
3. 设置最新版指针，并为现有竞赛固定 V1，策略统一为 any。
4. 现有提交保留 `submitted_version_id = NULL`、`legacy_unknown`。
5. 将既有结果转成 `legacy_import` 尝试及未知版本当前判定。
6. 对两类提交计算初始有效属性，保持原有历史成绩。
7. 回填后添加最终 NOT NULL、复合外键和必要约束。
8. 全部运行期读取迁移完成后，删除旧 `evaluation_results`、`objective_questions`。
9. 重建用户榜单物化视图及搜索索引。

不能把迁移基线 V1 当成历史提交的真实提交时版本。只有后续明确在 V1 执行的评测，才能产生已知 V1 成绩。

存储不存在、旧客观题已经被替换等历史信息无法恢复，保留未知或缺失状态。

迁移安全必须在有存量数据的数据库验证；禁止仅凭空库迁移通过宣称可升级。

### 8.2 文档交付

新增一篇用户与管理员可读的版本管理文档，包含：

- 草稿与发布。
- 提交时版本与评测版本。
- 历史均有效与精确版本。
- 用户升级、管理员重测、批量进度。
- 客观题标识和强行重判。
- 产物保留及历史缺失。

同步现行：

- 根 README、AGENTS 和相关模块入口文档。
- 题型介绍与出题指南。
- 题包规范、小题 key 和导入发布参数。
- 题单、提交、竞赛、通过状态及重测说明。
- 生产升级、备份恢复与演练文档。

AI 评测机制的介绍明确适用范围，避免继续将 dual 模型描述为 NOJ 的唯一评测模型。现行 OI 与客观题规则同步修正。历史设计稿和 Agent Notes 保留其历史语境，添加新决策链接。

### 8.3 上线默认方案

本次为 core、judge、gateway、UI、IDE 和 CLI 的协调升级，不支持新旧评测协议混跑。

1. CI、迁移演练与完整验收通过。
2. 进入维护窗口，停止新提交和编辑。
3. 排空 Judge 队列与活动评测。
4. 备份数据库及对象存储。
5. 应用迁移并同步升级各服务。
6. 核对迁移数量、投影、版本文件和未知历史标记。
7. 执行全题型冒烟与正式成绩读取验证。
8. 恢复访问。

回滚使用升级前备份及同版本服务组合，不能仅回退 core 二进制读取新 schema。

---

## 9. 测试与执行顺序

### 9.1 必须新增的测试组

| 测试组 | 必须覆盖 |
|---|---|
| 版本发布 | 草稿不影响作答、相同内容不发新版本、并发发布冲突、文件引用固定 |
| OI | ZIP 与逐文件快照一致、旧 checker/测试点可重测、native/WASM 配置固定、语言不兼容 |
| 有效投影 | V1 AC/V2 WA、同版 AC→WA、any/exact 来回切换、未知版本、通过指针与分数指针分开 |
| 竞赛 | 固定版本、题库更新隔离、两场竞赛策略独立、时间排序、封榜、结算与正式修订 |
| 客观题 | key 稳定、增删题、题型变化、旧答案重判、迁移 UUID、竞赛一次提交限制 |
| 产物 | 保留、升级共享、失败补偿不误删、缺失文件、新版大小限制 |
| 批任务 | >500 条、成员集合固定、lease 恢复、重复受理、部分失败、活动提交跳过 |
| 结果并发 | 重复消息、旧 sequence、错版本、旧 run_id、结果早于入队状态更新 |
| LLM | 新尝试独立预算、重派共享预算、旧 token 仍吊销、平台累计额度、Provider 缺配 |
| 权限 | 跨用户升级、私有题、历史版本保密、历史 details 裁剪、任务读取及 SSE 权限 |
| 缓存 | 策略提交后立即读取新口径、视图落后回退、并发刷新、多副本无进程内状态依赖 |
| 迁移 | 有存量成绩、替换过的客观题、缺失产物、缺失支持包、旧榜单与快照保留 |

并发锁、partial index、复合外键和迁移必须在真实 PostgreSQL 中验证；PGlite 用于快速逻辑验证，不能替代这些场景。

### 9.2 实施批次

1. **基础模型**：schema、类型、纯计算器、PGlite DDL、迁移夹具。
2. **版本写入**：草稿、发布、文件引用、OI 保存与客观题快照。
3. **评测链路**：attempt、协议、结果事务、LLM 生命周期、自测与 sweeper。
4. **管理操作**：策略切换、后台任务、管理员重测、用户升级。
5. **读取统一**：通过状态、题单、排行、个人资料、社区门槛、搜索、正式成绩。
6. **客户端**：Web 编辑器与提交、管理界面、IDE、CLI 与生产演练。
7. **存量收尾**：迁移回填、旧表删除、备份恢复验证。
8. **文档和交付**：现行文档、Agent Note、全量验收及 PR。

每批次先通过相关域测试再进入下一批；最终提交必须是完整协调升级的可部署状态。

### 9.3 验证命令与交付门禁

- core：使用 `deno task test:domain`，覆盖 catalog、objective、submission、contest、query、identity、community、search、gateway、admin。
- 共享测试：使用规定的 `bash scripts/test-shared.sh`。
- 跨模块 E2E：在 noj-tests 使用 `deno task test:domain cross-domain`，并补齐相关题型域。
- UI：`deno task test`、必要组件测试、类型检查。
- Judge：`cargo nextest run --all-targets`，相关 Docker E2E、fmt、clippy。
- gateway 与 CLI：各模块 `deno task test` 和 check。
- 文档站构建、文档链接、迁移安全、域边界、契约夹具及 Agent Note 校验。
- 修改前检查 GPG 签名；使用签名主题分支和 PR，不直接推送 main。
- `_journal.json`、lock 文件按工具生成规则处理。
- 新增或更新 implemented Agent Note，说明有效成绩物化、独立作用域、跨版本保留和协调升级的决定。

