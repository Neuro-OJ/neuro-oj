# 临时任务跟踪：题目版本管理实施

> ⚠️ **本文件是实施期的临时进度跟踪，目标交付完成后必须删除**（见文末「交付前删除清单」）。
> 详细设计规则以《Neuro OJ 题目版本管理实施 Handbook》为准；长期证据记录见
> [`dev-docs/superpowers/plans/2026-10-09-problem-version-management.md`](../../dev-docs/superpowers/plans/2026-10-09-problem-version-management.md)。
>
> 维护方式：每完成一个可验证的最小单元就更新本文件（状态 + 证据 + 下一步），
> 使任何一轮中断后都能从本文件直接续接。

- 目标分支：`feat/problem-version-management`（GPG 签名，禁止直推 main）
- 当前轮次：goal round 36
- 最近更新：批次 2d 落地——客观题小题路由改走共享草稿（`If-Match` 乐观锁）、
  编辑者读草稿/作答者读版本快照、题包导入直写草稿（小题稳定 key 支持显式指定）、
  web 客观题编辑器「保存信息 + 发布版本」；noj-tests 客观题 E2E 与 helper 同步

## 一、批次状态总览

| # | 批次 | 状态 | 备注 |
|---|---|---|---|
| 1 | 基础模型（schema/类型/纯计算器/PGlite DDL/迁移 0102） | ✅ 完成 | parity 68 表/613 列 |
| 2 | 版本写入（草稿、发布、文件引用、OI、客观题快照） | 🟡 部分 | 2a/2b/2c/2d/2e 全部落地（含客观题小题路由与导入直写草稿）；剩 ZIP worker revision 绑定用例、OI 自测临时包 |
| 3 | 评测链路（attempt、协议、结果事务、LLM、sweeper、自测） | ✅ 完成 | 含协议 v2、contest 口径修复、LLM attempt 作用域 |
| 4 | 管理操作（策略、批任务、重测、升级） | ✅ 完成 | 派发 + 路由 + 旧入口适配层；竞赛固定版本创建/编辑写入；§4.5 三个策略/固定版本端点已补；仅「代他人升级」旁路未做 |
| 5 | 读取统一（通过状态、题单、排行、资料、社区、搜索、正式成绩） | ✅ 完成 | 5a/5b/5c/5d 全部落地：stats-cache 去进程内状态、未发布题目不进公共面、搜索只索引已发布、提交读路径版本信息、Kaggle 计分读竞赛有效成绩、正式快照记录策略与尝试归因 |
| 6 | 客户端（Web、IDE、CLI、演练） | ✅ 完成 | CLI/LMCC/E2E 完成；noj-ui 提交侧、提交列表/详情版本展示、管理端（版本策略 + 批量重测）、AI/代码 + OI + 客观题编辑器草稿发布流全部完成 |
| 7 | 存量收尾（回填、旧表删除、视图/索引重建、备份恢复验证） | 🟡 部分 | 0103 回填 + 真实库演练完成；旧表**读写引用已全部清零**（仅剩 schema 定义）、写入双写移除、`user_rankings` 视图已重建（0104）；剩删表迁移、`pinned_version_id` 收紧、索引重建与备份恢复演练 |
| 8 | 文档与交付（现行文档、Agent Note、验收、PR） | ⬜ 未开始 | 含删除本跟踪文件 |

图例：✅ 完成　🟡 部分　⬜ 未开始

## 二、逐项清单（未完成项）

### 批次 2（版本写入）
- [x] 2d 客观题小题写共享草稿（路由 + 读取分流）：
      `POST/PUT/DELETE /problems/:id/questions` 改走 `objective-drafts` 服务
      （`If-Match` / `body.expected_revision`，缺失 428、过时 409、成功响应回传
      `draft_revision`；删除由 204 改为 `200 { draft_revision }`）；读取分流——
      编辑者读草稿（含答案解析）、其他访问者读**默认作答版本快照**并裁剪答案，
      未发布套卷对非编辑者 404；`serializeQuestion` 的 `id` 改返回稳定 `key`；
      草稿内 `sort_order` 唯一（保留原 400 语义）；旧 `createQuestion/updateQuestion/
      deleteQuestion`（写 `objective_questions`）删除。
- [x] 2d 题包导入直写草稿：`importObjectivePaper` 生成/保留小题 UUID 作为 key 并
      写草稿 content（旧表只留兼容镜像，供 `legacy_unknown` 存量提交展示）；
      `publishImportedProblem` 统一「发布当前草稿 revision」；
      `questions.json` 支持可选 `key`（非空、同包内不重复），
      `ObjectiveQuestionBundleInput` 类型 + 2 个解析用例。
- [x] 2d/6 客观题编辑器：`useObjective` 增加 `getDraft` / `publishDraft`，
      小题写入携带 `If-Match` 并回写新 revision；`ObjectiveProblemEditor.vue`
      以草稿为编辑初值（题面/描述/小题/ revision）、显示最新版与 revision、
      新增「发布版本」按钮，管理信息（标签）仍直接生效。
- [x] 2d noj-tests 同步：`e2e/helper.ts` 的 `apiPut`/`apiDelete` 支持自定义头；
      客观题 E2E 建立 revision 链、创建小题后**显式发布 V1**（作答与公开读取的
      事实源）、更新小题走 `If-Match`、补 428 断言。
- [ ] ZIP worker 结果绑定草稿 revision 的**并发用例**（当前由「先打包、后带
      `expectedRevision` 提交」结构性保证：陈旧 ZIP 会被 409 拒绝并补偿已上传对象，
      缺一个显式用例把这个不变量钉住）。
- [ ] OI 自测从所选版本构造临时包并登记临时对象引用。

### 批次 5（读取统一）
- [x] `query/services/stats-cache.ts`：删除全部进程内计数器（含 Redis 离线回退），
      改 revision 键控的数据库聚合 + Redis 缓存；满分口径读有效成绩投影，
      不再依赖待删除的 `evaluation_results`。
- [x] `search/services/index-writer.ts`：只索引已发布题目（草稿不入公开索引）。
- [x] 未发布题目不进公共读取面：详情对普通访问者 404（编辑者可读）、公共列表排除、
      搜索索引排除（新增测试夹具助手 `publishBaselineVersionForTest`）。
- [x] 5d 正式成绩快照归因：快照每题结果记录版本策略/固定版本/有效尝试/提交时版本
      （Kaggle 排名 SQL 加列 + payload + 类型 + 用例）。
- [x] 5d 收尾：实时 Kaggle 计分来源迁移到 `is_contest_valid` + 竞赛有效尝试。

### 批次 6（客户端 · noj-ui）
- [x] `composables/useProblemVersions.ts`：草稿读写（`If-Match` 乐观锁）、发布预检/发布、
      版本列表与指定版本、题库/竞赛策略切换、竞赛固定版本升级、批任务受理（幂等键）/
      详情/条目/重试、升级任务受理与读取、终态轮询；配套 8 个 vitest 用例。
- [x] `pages/problems/[id].vue`：作答版本提示（含「题库固定/最新版/未发布」）+ artifact
      提交携带 `version_id` + 409 `VERSION_REQUIRED`/`CONTEST_PROBLEM_VERSION_CHANGED` 刷新题目。
- [x] `pages/editor/[id].vue`：`submit()`/`selfTest()` 携带 `version_id`，副标题展示作答版本，
      409 时刷新题目（不自动换版、代码留在编辑器）。
- [x] `composables/useObjective.ts` + `components/objective/ObjectiveAnswerForm.vue`：
      客观题提交携带 `version_id`（练习与竞赛两处调用点）。
- [x] `pages/contests/[contestId]/problems/[label].vue`：固定版本提示 + artifact/客观题提交
      携带 `version_id` + 409 保留已选内容并刷新固定版本。
- [x] `components/editor/CodingProblemEditor.vue`：编辑模式以 `GET /problems/:id/draft`
      为编辑初值，新增「保存草稿」（`If-Match` + 管理信息同批提交）与「发布版本」
      （先存后发、相同内容复用既有版本、页内显示最新版与草稿 revision）。
- [x] `components/editor/OiProblemEditor.vue`：保存携带 `draft_revision`、保存后刷新
      文件列表与新 revision、新增「发布版本」按钮；内容以草稿为编辑初值。
- [x] `components/objective/ObjectiveProblemEditor.vue`：小题写草稿（携带 revision、
      稳定 key）、以草稿为编辑初值、「发布版本」整卷发布。
- [x] 提交时版本展示（core + UI）：`GET /submissions/:id` 新增
      `submitted_version_id`/`version_origin`/`submitted_version`/`upgraded_from_id`/
      `effective_version_policy`/`version_results[]`（各版本当前判定，含 `is_effective`/
      `is_accepted`）；列表项新增提交时版本三字段；
      `noj-ui/pages/submissions/[id].vue` 增加"作答版本"元信息 + 「各版本判定」表格 +
      「由旧版本提交升级而来」来源链接，`pages/submissions/index.vue` 增加版本列。
- [x] 提交列表按版本/有效性筛选 + 用户批量升级入口：
      core `GET /submissions` 新增 `version_id` / `version_origin` / `valid_only` /
      `accepted_only` / `upgradable`（可升级 = 题目已发布且提交时版本 ≠ 最新版），
      非法 `version_origin` → 400；noj-ui 提交列表新增作答版本筛选、仅可升级/仅有效
      开关、勾选列与「批量升级到最新版」（≤500、幂等键、轮询到终态、失败原因聚合）。
- [x] `pages/admin/*`：三种重测范围、固定版本映射、独立策略切换、任务进度与重试。

### 批次 5/7（读路径去旧结果表）
- [x] 用户主页最近提交、个人数据导出、评测队列最近完成分数、站点统计 accepted
      全部改读尝试/有效成绩投影（不再 JOIN `evaluation_results`）。
- [x] 提交详情/列表最近结果、竞赛结算就绪状态改读尝试（含 `platform_error` 区分）。
- [x] `contest-ranking.ts`：结算就绪与 Kaggle 计分全部改读尝试/竞赛有效成绩投影。
- [x] `submissions-result.ts` 结果写入双写已移除：评测事实唯一来源是
      `evaluation_attempts` 终态 + `submission_version_results` 当前判定 + 有效成绩投影；
      7 个断言旧表的用例改写为断言尝试终态/历史保留/投影指针
      （`saveEvaluationResult` 5 个 + mq/consumer 1 个 + self-test-consumer 1 个）。
- [x] 全部 `evaluation_results` 引用已清空（除 `src/shared/db/**` 的 schema 定义）：
      12 个测试文件夹具改写为「提交 + 尝试 + 投影指针」或直接删除旧结果行；
      `problems-crud.ts` 删除清理移除（尝试随提交级联）。
- [x] 顺带修复结算门禁 **fail-open**：`failed` 表达式在三值逻辑下为 NULL 时既不算
      failed 也不算 pending（"无尝试的提交"会被静默放过）；改为 `COALESCE(..., FALSE)`
      收敛为布尔，并给路由夹具补上终态尝试。

### 批次 7（存量收尾）
- [ ] 大库分批重算投影（`recomputeProblemProjections` 当前逐条）。
- [ ] `contest_problems.pinned_version_id` 最终 `SET NOT NULL`。
- [x] 重建用户榜单物化视图：迁移 `0104_rebuild_user_rankings_view.sql`（`drizzle-kit
      generate --custom` 生成，journal 由工具维护）把 `user_rankings` 从
      `evaluation_results` 改读 `submissions.is_accepted`；已应用到开发库。
      这是"停写旧表"暴露的必然依赖：旧视图在新模型下必然为空，测试
      `refreshRankingsView()` 后会读到空榜。
- [x] **删除旧表 `evaluation_results`**：迁移 `0105_superb_major_mapleleaf.sql`
      （`deno task db:generate` 生成，含中文前置条件说明）、移除 Drizzle schema 定义、
      同步 `schema-ddl.ts`（建表段/索引/ALL_TABLES）与顶层 schema 测试；
      parity 门禁自动收敛为 **67 表 / 604 列**；PGlite 模板已重建；
      开发库已应用（`public.evaluation_results` 已不存在，`user_rankings` 视图在）。
- [ ] 删除旧表 `objective_questions`（其运行期读取迁移完成后；小题事实源已逐步转向
      版本快照与草稿）。
- [ ] 搜索索引重建；备份/恢复演练验证。

### 批次 8（文档与交付）
- [ ] 新增用户/管理员版本管理文档（草稿发布、提交时版本、any/exact、升级/重测/进度、
      客观题标识与强行重判、产物保留与历史缺失）。
- [ ] 同步现行文档：根 README/AGENTS、题型与出题指南、题包规范与 `--publish`、
      题单/提交/竞赛/重测说明、生产升级与备份恢复文档。
- [ ] 新增或更新 implemented Agent Note（有效成绩物化、独立作用域、跨版本保留、协调升级）。
- [ ] 全量验收：core 各域 + shared + judge + gateway + UI + E2E；迁移安全与真实库演练。
- [ ] PR：从 `feat/problem-version-management` 合入 `main`（GPG 签名、CI 全绿）。
- [ ] **删除本跟踪文件**（见文末清单）。

### 批次 4 补充（§4.5 端点 + 管理端页面）
- [x] `PUT /api/v1/admin/problems/:id/effective-version-policy`、
      `PUT /api/v1/admin/contests/:contestId/problems/:problemId/effective-version-policy`、
      `PUT /api/v1/admin/contests/:contestId/problems/:problemId/version`
      （新路由文件 `noj-core/src/domains/admin/routes/problem-versions.ts`，挂在
      `/api/v1/admin` 根下以匹配 Handbook 路径；policy/expected_revision 服务端校验）。
- [x] 题目详情下发 `effective_version_policy_revision`；竞赛题目列表下发
      `effective_version_policy` 与 `effective_version_policy_revision`
      （管理端乐观锁所需）。
- [x] 竞赛题目列表的 `user_status` 改读 `submissions.is_contest_accepted`
      投影，不再 JOIN 待删除的 `evaluation_results`。
- [x] noj-ui `pages/admin/problem-versions.vue`：题库策略切换（any/exact + 版本选择）+
      竞赛固定版本/策略逐题编辑（带 revision 乐观锁，冲突后自动重载）。
- [x] noj-ui `pages/admin/submission-jobs.vue`：三种重测范围（整题 / 整场 / 手选 ≤500）
      × 三种目标（提交时版本 / 最新版 / 全部用 V<n> 逐题展开，缺版即取消受理）、
      条目进度与 `reason_code` 说明、重试 failed/skipped 生成关联新任务。

### 批次 4 补充（竞赛固定版本落库）
- [x] 竞赛创建即固定每题当时最新已发布版（`contest_problems.pinned_version_id`）。
- [x] 编辑竞赛整体替换题目关联时保留既有固定版本（旧 null 按当前最新版回填），
      避免改名/改时间静默换版。
- [x] `POST /contests/:id/submit`（JSON 与 multipart）转发 `version_id`，
      不一致 → 409 `CONTEST_PROBLEM_VERSION_CHANGED`，并回传
      `expected_version_id`/`submitted_version_id`。

### 已知偏差 / 待收紧
- [ ] **客观题小题的旧表镜像**（2d 后仍写 `objective_questions`）：仅用于
      `legacy_unknown` 存量提交的展示回退与 `deriveDraftContentFromProblem` 派生；
      批次 7b 删除该表时同步移除镜像写入。删表后 `legacy_unknown` 存量提交将
      只显示"无小题"（Handbook §8.1 允许"历史信息无法恢复，保留未知状态"）。
- [ ] `resolveSubmissionVersion` 对「题目尚未发布任何版本」的存量题目仍返回
      `legacy_unknown`；批次 7 基线回填完成后收紧为拒绝。
- [ ] `rejudgeProblemSubmissions` 整题范围仍按 `submitted` 目标受理（适配层），
      界面「统一用 V3」需通过 `specified` 目标走统一任务服务。
- [ ] `acceptUpgradeJob` 尚无管理员旁路（管理入口「代他人升级」）。
- [ ] 竞赛提交**缺省** `version_id` 且题目已固定版本时仍按固定版本作答（迁移期兼容，
      批次 7 后收紧为 409 `VERSION_REQUIRED`，与题库路径对齐；已写入
      `submission-version.ts` 头注释）。

## 三、最近验证证据

| 范围 | 命令 | 结果 |
|---|---|---|
| noj-core 全量 | `cd noj-core && deno task test:parallel` | **1408 passed / 0 failed / 11 ignored**（批次 2d 后） |
| objective 域 | `bash scripts/test-domain.sh objective` | **56 passed / 0 failed**（+1 草稿/快照分流、7 个原用例改走 revision 链） |
| catalog 域 | `bash scripts/test-domain.sh catalog` | **307 passed / 0 failed**（+1 小题 key 解析；客观题导入用例改走真实题包） |
| noj-ui 单测 | `cd noj-ui && deno task test` | **235 passed / 0 failed** |
| noj-ui 类型 | `deno task check:types` + `deno task check:types:nuxt` | **0 error** |
| noj-ui 组件 | `deno task test:components`（vitest） | **102 passed / 19 files** |
| noj-tests 类型 | `deno check e2e/objective/objective.test.ts e2e/helper.ts` | 通过（本地无 E2E 栈，运行验证留给 CI） |
| 静态门禁 | lint / fmt / 域边界 / JSDoc / 迁移安全 | 全绿 |
| noj-core 全量 | `cd noj-core && deno task test:parallel` | **1406 passed / 0 failed / 11 ignored**（批次 2c/2e 后） |
| noj-core 全量 | `cd noj-core && deno task test:parallel` | **1403 passed / 0 failed / 11 ignored** |
| contest 域 | `bash scripts/test-domain.sh contest` | **86 passed / 0 failed**（+1 结算就绪读尝试、+1 快照归因、+1 投影计分） |
| catalog 域 | `bash scripts/test-domain.sh catalog` | **303 passed / 0 failed**（+2 未发布可见性） |
| search 域 | `bash scripts/test-domain.sh search` | **30 passed / 0 failed / 1 ignored** |
| submission 域 | `bash scripts/test-domain.sh submission` | **224 passed / 0 failed / 21 ignored**（+1 最近结果读尝试） |
| identity 域 | `bash scripts/test-domain.sh identity` | **310 passed / 0 failed / 26 ignored**（+1 最近提交读尝试） |
| query 域 | `bash scripts/test-domain.sh query` | **23 passed / 0 failed**（+1 站点统计读投影） |
| catalog 域 | `bash scripts/test-domain.sh catalog` | **301 passed / 0 failed** |
| submission 域 | `bash scripts/test-domain.sh submission` | **219 passed / 0 failed / 21 ignored** |
| identity 域 | `bash scripts/test-domain.sh identity` | **310 passed / 0 failed / 25 ignored** |
| admin 域 | `bash scripts/test-domain.sh admin` | **14 passed / 0 failed** |
| noj-judge | `cargo nextest run --all-targets` | **554 passed / 45 skipped** |
| llm-gateway | `deno task test` | **99 passed / 0 failed / 1 ignored** |
| noj-ui 单测 | `cd noj-ui && deno task test` | **235 passed / 0 failed** |
| noj-ui 类型 | `deno task check:types` + `deno task check:types:nuxt`（nuxt typecheck + vue-tsc） | **0 error** |
| noj-ui 组件/composable | `deno task test:components`（vitest） | **102 passed / 19 files**（含新增 8 个版本 API 用例） |
| 静态门禁 | lint / fmt / 域边界 / JSDoc / parity / 迁移安全 / 快照链 | 全绿 |

- 真实 PostgreSQL 存量演练（0102+0103）：7 基线 / 123 legacy 尝试 / 123 未知桶判定 /
  123 有效投影，与旧读取口径 **0 差异**；开发库已升级。
- 读路径收敛进度：`evaluation_results` 的**运行期读取已全部迁离**
  （列表/详情/队列/站点统计/个人主页/数据导出/竞赛题目通过状态/结算就绪/Kaggle 计分），
  **写入双写也已移除**；剩余引用只在测试夹具与两处 schema 定义，删表迁移是下一步。
- 提交历史：**41 个 GPG 签名提交**在 `feat/problem-version-management`，工作副本干净。
- 环境注意：`noj-lmcc-extension` 的 `npm run check` 因缺 `@types/node` 与
  `moduleResolution=node10` 弃用报错（预先存在，非本次改动引入）。

## 四、下一步（按优先级）

1. **批次 2 收尾**：ZIP worker 陈旧结果并发用例；OI 自测从所选版本构造临时包
   （登记临时对象引用）。
2. **批次 7b**：`contest_problems.pinned_version_id` 收紧 NOT NULL（含存量回填）→
   删除 `objective_questions`（含移除导入镜像写入、存量回填后的读取口径复核）→
   重建搜索索引 → 备份/恢复演练。
3. **批次 8**：版本管理文档、同步现行文档（README/AGENTS/题型/题包/题单/提交/竞赛/升级）、
   implemented Agent Note、全量验收（core 各域 + shared + judge + gateway + UI + E2E）、
   PR 合入 `main`。
4. 交付前删除本跟踪文件（见文末清单）。

## 五、交付前删除清单（本文件生命周期的收口）

1. 批次 8 全部完成后：`rm .agents/tasks/problem-version-management.md`（并删除空的
   `.agents/tasks/` 目录）。
2. 确认仓库无其它引用：`rg -n "problem-version-management.md" --hidden` 只在
   `dev-docs/` 的实施计划中出现（计划文档本身是长期交付物，保留）。
3. 确认删除提交落在本分支最后：该跟踪文件在实施期**随轮次一起提交**（已进入本分支
   历史，合入后不再存在于 `main` 工作树），删除动作必须出现在批次 8 的收尾提交里；
   `jj log --no-graph -r 'feat/problem-version-management' -T 'description.first_line() ++ "\n"' | head -3`
   确认最新提交即"删除跟踪文件"。
4. 交付 PR 前最后一遍：`jj status` 干净、`git log --show-signature -1` 为 `G`。
