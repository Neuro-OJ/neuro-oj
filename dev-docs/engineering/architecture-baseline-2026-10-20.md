# NOJ 架构整治 P0：架构基线冻结（2026-10-20）

> **时点快照**：本文档是 P0 批次交付物，对应
> [NOJ 架构整治方案](../superpowers/plans/2026-10-20-architecture-remediation.md)（下称"方案"）
> §5 的 P0 行与 §7 跟踪清单第 1 项。它只登记**测量时刻**的事实：受审版本、当前代码分区、
> 目标模块映射、表与后台任务所有权、代表性请求/查询/行为基线。本文不回溯修改既有结论；
> 被后续代码推翻时按 [工程规范 README](README.md) 的时效约定处理（评审/审计类文档为时点快照）。
> 本轮只新增文档，**不修改生产代码与既有文档**。

- 受审提交：`fbc40624`（`codex/learning-ui-restructure` bookmark，即 jj 工作副本父提交）
- 对照分支：`main` = `2f488599`
- 测量时间：2026-10-20 07:25–07:40（Asia/Shanghai）
- 基线读取口径：**一律以 `fbc40624` 的已提交树为准**。测量时工作副本还包含其他批次的
  在途改动（如 P1 的 `noj-core/src/shared/db/migrate.ts`、`noj-llm-gateway/src/app.ts`、
  `noj-cli/src/prod/lifecycle.ts` 等），这些改动**不纳入**本基线；引用相关文件时使用
  `git show fbc40624:<path>` 读取基线版本。

## 1. 冻结范围与测量口径

### 1.1 本文回答的问题

1. 本次架构改造审的是哪个版本？它和 `main` 是什么关系？（§2）
2. 当前代码分成哪些域/目录，未来落到哪些 `modules` 分区？（§3、§4）
3. 109 张物理表当前由谁持有、目标归属哪个分区？（§5）
4. 有哪些后台消费者/worker/sweeper/保留任务，如何启动与停止，配置在哪？（§6）
5. 路由、事件、门禁、测试入口这些"代表性基线"从哪来、规模多大？（§7）

### 1.2 引用惯例

- 代码事实一律附 `路径:行号`。行号以 `fbc40624` 已提交树为准；测量时工作副本若有
  他批改动，相关文件用 `git show fbc40624:<path>` 核对。
- 计数均为命令输出，复现命令写在各节。与方案描述不一致时以本文实测为准，并注明差集。
- 文档链接遵循 [CONTRIBUTING](../../CONTRIBUTING.md) §文档与决策记录：
  "Markdown 相对链接必须指向仓库内存在的文件和标题"。

### 1.3 本轮未覆盖（重要）

本 P0 **没有**做以下事情，不能在后续批次中当作已经验证：

- 线上/固定数据集性能压测（浏览器请求数、Core 请求数、SQL 数量、冷暖延迟均未测量）；
- 全量测试（`deno task test` / `test:parallel` / `test:domain`）、跨模块 E2E、
  `noj-tests` 浏览器 E2E、`noj-judge` Docker E2E 均未运行；
- 生产备份/恢复演练、升级演练、故障注入；
- 多副本（K8s/水平扩展）行为验证；
- 前端 1440/768/390px 与键盘可用性验证。

本轮实际执行的命令只有：只读的 `jj`/`git`/`rg`/`find` 查询、两个生成物门禁的
`--check`、以及写入本文件后的 Markdown/Agent Note 格式自检（见 §7.6）。

## 2. 版本归属：本地链与 main

### 2.1 版本事实

| 项 | 值 | 来源命令 |
| --- | --- | --- |
| 受审提交 | `fbc4062419cb3de008c2fda004407c8718865c10` | `git rev-parse HEAD` / `jj log -r @-` |
| 受审 bookmark | `codex/learning-ui-restructure` | `jj --ignore-working-copy bookmark list` |
| `main` 提交 | `2f488599db9f4c9e2adc64410deb06139ad273b5` | `git rev-parse main` |
| 两链分叉点 | `e4de4dd0`（2026-10-13，#641） | `git merge-base main HEAD` |
| `main` 独有提交 | 28 条（2026-10-14 — 2026-10-17） | `git rev-list --count HEAD..main` |
| 本地链提交（已提交） | 292 条 | `git rev-list --count main..fbc40624` |
| 本地链提交（含工作副本快照） | 293 条 | `jj --ignore-working-copy log -r 'main..@' --no-graph \| wc -l` |
| 本地链 vs 分叉点差异 | 1539 文件，+202910 / −16504 | `git diff --shortstat main...fbc40624` |
| `main` vs 分叉点差异 | 152 文件，+7456 / −873 | `git diff --shortstat fbc40624...main` |

> **关于"多 293 个提交"的口径**：`git rev-list --count main..fbc40624` 为 **292**；
> jj revset `main..@` 为 **293**，差额 1 是测量时工作副本的临时快照提交（jj 的 `@`，
> 包含其他批次在途改动与方案文档），它不属于已提交历史。两个数字都正确，区别只是是否
> 计入工作副本快照。方案 §7 与任务描述中的 293 指后者。

### 2.2 本地链构成

提交类型分布（`git log --format='%s' main..fbc40624` 统计，合计 292）：

| type | 数量 |
| --- | --- |
| feat | 115 |
| fix | 62 |
| test | 56 |
| docs | 42 |
| refactor | 10 |
| ci | 2 |
| chore | 2 |
| style | 1 |
| perf | 1 |
| 无描述（`7b6e8a174`） | 1 |

按 scope 归属（主题串前缀统计）：

- scope 含 `ui` 的提交 **88** 条；
- 只含 `core`（不含 `ui`）的提交 **121** 条；
- 其余为 `tests`/`docs`/`root`/`cli` 等。

结论：受审链**不是纯 UI 分支**。它是 2026-10-12 起累积的混合链（工作空间/教学/竞赛/
题目版本 + UI 重组；diff 中 `noj-core` 616 文件、`noj-ui` 459 文件、`.agents` 246
文件）。任务描述中"比 main 多 293 个提交"应理解为"本地并行链整体"，而不是"仅 UI 提交"。

### 2.3 归属结论与架构批次边界

1. **本地链归本地链**：`codex/learning-ui-restructure` 及同一链上的
   `codex/nuxt-view-bff-ssr`（`4ff37ffb`）、`codex/product-architecture-upgrade`
   （`9b2e3d4c`）、`codex/domain-ui-repair`（`964bc145`）等 bookmark 均为
   `fbc40624` 的祖先，且都**不在** `main` 上（`git merge-base --is-ancestor` 核对）。
2. **`main` 归 `main`**：`main` 独有 28 条提交（10-14 — 10-17），主要是 judge/core/ui
   缺陷修复、依赖升级与 CI/发布准备；按 scope 出现次数为 judge 8、ui 7、core 7、root 5、
   deps 3、tests 2、ci 2、gateway 1、docs 1、cli 1（一条提交可含多个 scope）。它们**没有**
   进入本地链。
3. **架构批次（P0–P8）从 `fbc40624` 派生**：本文档及后续批次提交只包含架构改造本身的
   改动，不夹带、也不声称包含上述两条链的既有工作。与 `main` 的协调（合并/变基/发布）
   属于方案 §4.8 与 P8，不在 P0 范围内解决。
4. **已知异常（不影响树内容，协调时需确认）**：本地链含 2 个合并提交、1 条无描述的
   单父提交 `7b6e8a174`（2026-10-17，可能为 jj 快照遗留）。另外，
   `wip/global-annotations`（`9136606e`）、`feat/local-gpu-prediction-submission`
   （`90ff3c10`）、`feat/build-identity-footer`（`96516bbd`）等 bookmark 经
   `git merge-base --is-ancestor` 核对**不在**受审链上，属独立工作区/链，本轮不纳入。

### 2.4 复现命令

```bash
git rev-parse HEAD main
git merge-base main HEAD
git rev-list --count main..fbc40624     # 292
git rev-list --count fbc40624..main     # 28
git log --format='%s' main..fbc40624 | sed -E 's/^\(([a-z]+)\).*/\1/' | sort | uniq -c
git diff --shortstat main...fbc40624
jj --ignore-working-copy bookmark list
jj --ignore-working-copy log --no-graph -r 'main..@' -T 'commit_id.short() ++ "\n"' | wc -l  # 293
```

## 3. 当前代码分区（基线）

### 3.1 顶层结构

```text
noj-core/src/
├── app.ts            # 253 行：Hono 应用工厂、全局中间件、按域挂载路由（状态：组件存在）
├── main.ts           # 381 行：启动校验、初始化顺序、后台任务装配、优雅关闭
├── mod.ts            # 公共导出
├── domains/          # 17 个业务域，自包含 routes/services/middleware/mq/types/tests
└── shared/           # 12 个子目录 + 6 个顶层共享文件（见 3.2）
```

`shared/` 子目录：`base`、`config`、`db`、`http`、`mq`、`observability`、
`rate-limit`、`security`、`sse`、`testing`、`versioning`、`workspace`；
顶层共享文件：`contest-types.ts`、`education-contests.ts`、`education-events.ts`、
`education-modules.ts`、`education-types.ts`、`search-events.ts`。
（`domains` 与 `shared` 的职责边界见 [域边界与所有权](domain-boundaries.md)。）

### 3.2 现域清单（17 个）

计数方法：`find noj-core/src/domains/<域> -name '*.ts' -not -path '*/tests/*'` 与
`-path '*/routes/*.ts' -not -name 'index.ts'`。路由文件总数为 64，与
`gen-route-catalog --check` 输出一致（§7.1）。

| 当前域 | 子目录 | 非测试 `.ts` | 路由文件 | 主要职责（现状） |
| --- | --- | --- | --- | --- |
| `admin` | middleware/routes/services/tests/types | 16 | 11 | 管理端路由组合（identity/catalog/system/contest/community/gateway/submission/query 子域）+ 审计、乐观锁 |
| `catalog` | services/routes/tests/types | 66 | 9 | 题目、草稿/版本、标签、题单、题包、域绑定与共享 |
| `community` | services/routes/tests/types | 25 | 4 | 板块、帖子、评论、点赞、收藏、关注、举报、审核、通知 |
| `content-review` | providers/services/mq/tests | 13 | 0 | 内容审核 Provider、私信审核消费者（无 HTTP 路由） |
| `contest` | services/routes/tests/types | 27 | 3 | 竞赛、参赛者、赛题、澄清、榜单快照、题目保密 |
| `education` | routes/services/tests | 52 | 8 | 班级、作业、教学授权、学情、反馈、求助、补题、教学通知 |
| `gateway` | services/tests/routes | 8 | 1 | LLM Provider/模型别名/配额（远期迁入 `noj-llm-gateway`） |
| `identity` | services/routes/middleware/tests/types | 46 | 3 | 注册登录、JWT/RBAC、TFA、OAuth、封禁、用户资料 |
| `legal` | routes/services/tests | 11 | 4 | 法律文档、同意记录、数据请求 |
| `messaging` | services/routes/tests | 6 | 1 | 私信、会话、已读、删除、偏好 |
| `objective` | services/tests/types/routes | 10 | 1 | 客观题提交与即时判分 |
| `observability` | metrics/middleware/probes/routes/services/tests | 13 | 1 | 平台指标、探针、快照、健康/指标路由、SLO |
| `query` | services/routes/tests | 10 | 4 | 统计、排行、Dashboard 读模型、投影 revision |
| `search` | consumer/middleware/routes/services/tests | 9 | 1 | `search_entries` 索引、搜索消费者、搜索 API |
| `submission` | services/routes/mq/tests/types | 63 | 8 | 提交、评测尝试/有效成绩、重测批任务、MQ 生产/消费、SSE |
| `system` | services/routes/middleware/tests/types | 44 | 5 | 设置、公告、审计、IP 封禁、Judge 镜像、对象存储、邮件、限流 |
| `workspace` | middleware/routes/services/tests | 17 | 0 | 产品工作空间/Domain、成员、角色、邀请、实例政策（路由仅组合 `routes/index.ts`） |

合计：**436** 个非测试 `.ts` 源文件、**64** 个路由文件、**355** 条路由（§7.1）。

## 4. 目标 `modules` 分区映射

方案 §3.1 规定："采用 `modules` 作为代码分区名称，避免与产品中的 Domain 混淆。
目录搬迁随职责迁移一起完成，不安排仅修改路径的大批次。" 因此下表是**目标口径映射**，
不是已经完成的搬迁：测量时 `noj-core/src/modules/` 尚不存在
（`ls noj-core/src` 仅有 `app.ts`、`main.ts`、`mod.ts`、`domains`、`shared`），
`noj-core/src/routes/` 也已不存在（路由目录生成器对旧路径做了存在性判断）。

### 4.1 分区映射总表

| 目标分区 | 当前源码（基线路径） | 目标路径（方案口径） | 归并方式（方案 §3.1 / §4） | 批次 |
| --- | --- | --- | --- | --- |
| `access` | `noj-core/src/domains/identity/`（46 ts / 3 路由）、`domains/workspace/`（17 ts / 0 路由）、`shared/workspace/`（4 文件） | `noj-core/src/modules/access/` | 账户、角色、成员、邀请、访问上下文；内部保留身份与空间子模块 | P3 |
| `problems` | `domains/catalog/`（66 ts / 9 路由）、`domains/objective/` 内容侧、`domains/admin/routes/catalog.ts` | `noj-core/src/modules/problems/` | 题目、草稿、版本、共享绑定、题单、客观题内容；判分执行移出 | P3 |
| `evaluations` | `domains/submission/`（63 ts / 8 路由）、`domains/objective/` 判分侧（10 ts / 1 路由）、`shared/versioning/`（5 文件） | `noj-core/src/modules/evaluations/` | 提交、自测、尝试、有效成绩、重测任务、客观题判分、Judge 消息 | P3/P4 |
| `contests` | `domains/contest/`（27 ts / 3 路由） | `noj-core/src/modules/contests/` | 比赛生命周期、参赛关系、赛题固定版本、赛制、正式榜单 | P3 |
| `education` | `domains/education/`（52 ts / 8 路由）、`shared/education-*.ts`（4 文件） | `noj-core/src/modules/education/` | 班级、作业、学情、教学互动与教学通知 | P3/P4 |
| `communication` | `domains/community/`（25 ts / 4 路由）、`domains/messaging/`（6 ts / 1 路由）、`domains/content-review/`（13 ts / 0 路由） | `noj-core/src/modules/communication/` | 社区、私信、内容审核；保留各自权限与存储子模块 | P3 |
| `assets` | `domains/system/services/storage/`（9 文件）、表 `storage_objects`/`storage_object_reservations`/`domain_storage_*`、catalog 的对象引用表 | `noj-core/src/modules/assets/` | 对象登记、上传预约、引用保护、容量核算与交付 | P3/P4 |
| `platform` | `domains/system/` 设置/公告/审计/IP 封禁/Judge 镜像（44 ts / 5 路由）、`domains/legal/`（11 ts / 4 路由） | `noj-core/src/modules/platform/` | 实例设置、公告、法律与同意记录等平台能力 | P3 |
| `read-models` | `domains/query/`（10 ts / 4 路由）、`domains/search/`（9 ts / 1 路由）、教学聚合（`education/services/progress-read.ts` 等） | `noj-core/src/modules/read-models/` | 跨模块展示查询、搜索、统计、榜单、教学聚合 | P3/P4 |
| `application` | 当前散落在各域 services 中的跨模块用例（如 `submission/services/domain-submissions.ts`、`education/services/assignment-lifecycle.ts`、`catalog/services/domain-resource-*`） | `noj-core/src/modules/application/` | 跨模块写流程编排；应用用例负责事务 | P3 |
| `http` | `noj-core/src/app.ts`（253 行，路由挂载 4.2 节）、`domains/*/routes/`（64 文件 / 355 路由）、`domains/admin/` 路由组合、`shared/http/` | `noj-core/src/modules/http/` | 解析、认证入口、状态码与响应转换；管理端路由归 HTTP 组合层 | P3/P7 |
| `runtime`（任务描述中亦称 `infrastructure`） | `noj-core/src/main.ts`（381 行）、`shared/{db,mq,sse,config,observability,rate-limit,base,security,testing}/`、`domains/observability/`（13 ts / 1 路由）、`domains/gateway/`（8 ts / 1 路由，P5 后外迁） | `noj-core/src/modules/runtime/` | 外部能力装配、启动/关闭、后台任务生命周期；Gateway 能力迁往 `noj-llm-gateway` | P2/P5 |

保留的独立运行时（不并入 Core 分区）：`noj-judge`（Rust Worker）、
`noj-llm-gateway`（Deno/Hono 服务）、`noj-ui`（Nuxt + Nitro BFF）、`noj-cli`、
`noj-lmcc-extension`。方案 §3.1 明确"保留 Core、Judge、LLM Gateway 三个运行服务"。

### 4.2 共享物的归属（跨分区）

| 当前共享物 | 内容 | 目标归属 |
| --- | --- | --- |
| `shared/versioning/` | 尝试终态、有效成绩策略、提交来源、判定 | `evaluations` |
| `shared/workspace/` | 工作空间审计、能力、资源策略、类型 | `access` |
| `shared/search-events.ts` | 搜索索引事件契约（`noj:search:index`） | `read-models` 与 `runtime` 之间的显式契约 |
| `shared/education-events.ts`/`education-contests.ts`/`education-modules.ts`/`education-types.ts` | 教学 outbox 登记、教学-竞赛关联、模块开关、类型 | `education` |
| `shared/mq/judge-queues.ts` | 评测队列布局与前缀（`JUDGE_QUEUE_LAYOUT`/`JUDGE_QUEUE`） | `runtime` + 与 `noj-judge` 的跨语言契约 |
| `shared/sse/` | 事件总线、SSE 流、事件保留 | `runtime` |
| `shared/db/`、`shared/config/` | 连接/迁移/schema 与设置注册表 | `runtime` |

### 4.3 搬迁原则（引自方案，供各批次验收）

- 目录搬迁与职责迁移一起完成；不安排仅改路径的大批次（方案 §3.1）。
- 业务模块不调用其他模块写服务；跨模块写入由 `application` 用例开事务编排（方案 §3.2）。
- `read-models` 可依赖业务模块只读能力；业务模块不得反向依赖搜索/榜单/页面查询（方案 §3.2）。
- 数据库物理表**不随目录调整批量改名**（方案 §1 已确认取舍）。

## 5. 数据库表所有权

### 5.1 事实来源与计数

| 项 | 值 | 来源 |
| --- | --- | --- |
| 权威 schema 入口 | `noj-core/src/shared/db/schema.ts` → `schema/index.ts`（21 个域 schema 文件 barrel） | `read` 两文件 |
| 表定义数 | **109**（21 个 schema 文件中的 `pgTable(...)`） | 见 §5.2 提取脚本 |
| `schema-ddl` 镜像表数 | **109**（`ALL_TABLES`，当前与 Drizzle 一致） | `noj-core/src/shared/db/schema-ddl.ts:1166` 转出 `ALL_TABLES`（定义在 `schema-ddl-tables.ts`）；导入实测 109 |
| 迁移 SQL 文件 | **120**（`0000` – `0119`） | `ls noj-core/drizzle/*.sql \| wc -l` |
| `_journal.json` 条目 | **119**（最新 `0119_nasty_thena`） | `noj-core/drizzle/meta/_journal.json` |
| 迁移文件与 journal 差集 | `0007_fk_cascade.sql` 不在 journal 中（见 §5.3） | `comm -23` 比对 |
| 迁移历史建表（去重） | **117** 张；与当前 schema 差集为 **8** 张已下线/迁出表（见 §5.3） | 对 `drizzle/*.sql` 的 `CREATE TABLE` 去重后与 schema 比对；当前 schema 表全部有建表历史（反向差集 0） |

表清单提取脚本（只读；测量时临时使用，未写入仓库）：

```bash
deno eval -A 'import { readdirSync, readFileSync } from "node:fs";
const dir = "noj-core/src/shared/db/schema";
for (const f of readdirSync(dir)) if (f.endsWith(".ts") && f !== "index.ts" && f !== "common.ts") {
  const text = readFileSync(dir + "/" + f, "utf8");
  const names = [...text.matchAll(/pgTable\(\s*"([^"]+)"/g)].map((m) => m[1]);
  if (names.length) console.log(f, names.length, names.join(", "));
}'
```

> 与 [域边界与所有权](domain-boundaries.md#表所有权) 的差异：该文档的表所有权表只覆盖了
> 2026-09 时的核心表（identity/catalog/objective/submission/contest/community/messaging/
> system/gateway），未覆盖 2026-10 的工作空间、教学、对象存储、迁移元数据等新表；本文按
> 当前 21 个 schema 文件的全量清单登记。二者冲突时以本文（时点快照）与 schema 源码为准。

### 5.2 表所有权清单（按当前 schema 文件分组，共 109 张）

| schema 文件（表数） | 表 | 当前持有域 | 目标分区 | 备注 |
| --- | --- | --- | --- | --- |
| `identity.ts`（10） | `users`、`oauth_accounts`、`check_ins`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans`、`roles`、`permissions`、`role_permissions`、`user_roles` | identity | `access` | RBAC 与账户/Session 基础 |
| `workspace.ts`（12） | `domains`、`domain_memberships`、`domain_member_roles`、`domain_limits`、`domain_llm_settings`、`domain_resource_counters`、`domain_invitations`、`domain_invitation_redemptions`、`domain_join_requests`、`domain_creation_requests`、`user_workspace_preferences`、`domain_feature_intervals` | workspace | `access` | 产品 Domain 与成员/政策/配额 |
| `workspace-storage.ts`（2） | `domain_storage_objects`、`domain_storage_uploads` | workspace/system | `assets` | 域存储计量与上传核对（`domains/system/services/storage/domain-reconciliation.ts`） |
| `catalog.ts`（9） | `problem_versions`、`problem_drafts`、`problem_draft_objects`、`problem_version_objects`、`problems`、`tags`、`problem_tags`、`trainings`、`training_problems` | catalog | `problems` | `*_objects` 为对象引用，写入遵循 `assets` 的引用保护 |
| `catalog-workspace.ts`（7） | `domain_problem_bindings`、`problem_binding_history`、`problem_share_settings`、`problem_share_targets`、`training_share_settings`、`training_share_targets`、`domain_training_bindings` | catalog | `problems` | 域绑定与共享撤销事实 |
| `objective.ts`（1） | `objective_submissions` | objective | `evaluations` | 客观题内容已随迁移 `0107` 删除 `objective_questions`，判分/尝试归评测 |
| `submission.ts`（8） | `submissions`、`evaluation_attempts`、`submission_version_results`、`submission_jobs`、`submission_job_items`、`self_tests`、`sse_events`、`llm_token_revocations` | submission | `evaluations` | `sse_events` 属事件基础设施（`runtime`，见 §4.2）；`llm_token_revocations` 为 LLM 执行撤销 outbox |
| `contest.ts`（5） | `contests`、`contest_problems`、`contest_participants`、`contest_clarifications`、`contest_ranking_snapshots` | contest | `contests` | 赛题固定版本与榜单快照 |
| `education.ts`（5） | `classrooms`、`classroom_memberships`、`classroom_assistant_grants`、`classroom_contest_links`、`classroom_join_requests` | education | `education` | 班级与教学授权 |
| `assignment.ts`（8） | `assignments`、`assignment_items`、`assignment_recipients`、`assignment_item_history`、`assignment_progress`、`education_outbox`、`education_disabled_intervals`、`education_operations` | education | `education` | `education_outbox` 是当前教学持久 outbox（§6.2 第 6 行；P4 迁入统一持久任务） |
| `education-interactions.ts`（5） | `assignment_feedback`、`assignment_help_requests`、`assignment_help_replies`、`education_notifications`、`education_notification_emails` | education | `education` | 教学互动与通知投递状态 |
| `submission-annotations.ts`（1） | `submission_annotations` | education | `education` | 教学批注（`domains/education/services/annotations.ts`） |
| `community.ts`（12） | `community_boards`、`community_board_role_grants`、`community_posts`、`community_comments`、`community_post_likes`、`community_comment_likes`、`community_bookmarks`、`community_follows`、`community_reports`、`community_moderation_actions`、`community_sanctions`、`community_notifications` | community | `communication` | 社区内容与治理 |
| `messaging.ts`（6） | `conversations`、`messages`、`message_reactions`、`conversation_reads`、`message_deletions`、`conversation_preferences` | messaging | `communication` | 私信 |
| `content-review.ts`（1） | `content_review_queue` | content-review | `communication` | 内容审核队列 |
| `legal.ts`（4） | `legal_documents`、`legal_document_versions`、`user_consents`、`data_requests` | legal | `platform` | 法律与同意记录 |
| `carousel.ts`（1） | `carousel_slides` | system | `platform` | 平台展示 |
| `system.ts`（8） | `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images` → `platform`；`storage_objects`、`storage_object_reservations` → `assets`；`llm_model_aliases` → `gateway` | system/gateway | `platform`/`assets`/`gateway` | 按表拆分：设置/公告/审计/封禁/镜像归平台；对象登记归资产；模型别名随 P5 迁 Gateway |
| `query.ts`（1） | `query_projection_revisions` | query | `read-models` | 统计缓存 revision（跨副本无进程内状态） |
| `search.ts`（1） | `search_entries`（含生成列 `search_vector` 与 GIN 索引） | search | `read-models` | 搜索索引唯一写者为搜索域 |
| `email.ts`（2） | `email_delivery_events`、`email_suppressions` | system | **待定** | 邮件是可替换外部能力（方案 §3.2），投递状态归属由 P3 决定 |

### 5.3 迁移链基线

- 迁移目录：`noj-core/drizzle/`；文件按编号严格递增，最新 `0119_nasty_thena.sql`；
  `_journal.json` 共 119 条（最后三条 `0117_workspace_pending_unique_indexes`、
  `0118_polite_fat_cobra`、`0119_nasty_thena`）。
- **历史建表与当前 schema 的差集（8 张）**：`categories`、`problems_categories`
  （题目分类下线）、`community_activity_events`（迁移 `0095`，VULN-08 下线）、
  `evaluation_results`（迁移 `0105` 删除，成绩事实源改为尝试+分版本判定）、
  `objective_questions`（迁移 `0107` 删除）、`llm_providers`/`llm_quotas`/`llm_usage`
  （迁出 core schema，由 `noj-llm-gateway/drizzle/0000_baseline.sql:1` 等同目录迁移在
  同一 public schema 管理，使用独立 `llm_schema_migrations` 记录表
  （`noj-llm-gateway/src/db/migrate.ts:8`）；core 不直接读写，
  见 [域边界与所有权](domain-boundaries.md#表所有权)）。
  反向核对无误：当前 109 张表在迁移历史中全部有 `CREATE TABLE`。
- **已知存量例外**：`0007_fk_cascade.sql` 存在但不在 `_journal.json` 中
  （命令：`comm -23 <(ls drizzle/*.sql | sed 's#drizzle/##; s#\.sql##' | sort) <(journal tags)`）。
  该文件是历史手工迁移（为 `problems`/`submissions` 等重建外键级联），
  `scripts/check-migration-snapshot-chain.ts:340` 在解析多行 `ALTER TABLE ... DROP CONSTRAINT`
  时专门以它举例。按项目规则 `_journal.json` 不可手改，故本轮只登记例外、不修复；
  迁移链权威性仍以 journal 顺序为准，P2/P8 处理历史迁移时需复核。
- 计数约定提醒：[工程规范 README](README.md) 要求"计数类陈述不写死"，改由门禁基线文件
  承载。本文是 P0 时点快照（评审/审计类文档例外），数字均附测量命令；后续批次改变结构时
  应新增快照或更新本文件对应节，不应把本文当作长期门禁基线（长期守护由
  `scripts/check-migration-safety.ts`、`scripts/check-migration-snapshot-chain.ts`、
  `scripts/check-schema-parity.ts` 承担）。

## 6. 后台任务与消费者

### 6.1 装配与关闭现状（基线）

启动顺序（`noj-core/src/main.ts:98`–`:106` 注释，实现以 `main()` 为准）：

1. `JWT_SECRET` 强度 + 占位值校验（失败退出）
2. `TFA_ENCRYPTION_KEY` 校验（失败退出）
3. 数据库迁移、Root、RBAC、默认工作空间、管理员初始化状态、设置注册表/缓存、默认域 LLM 配置
4. 邮件就绪检查（非致命）、生产配置校验（致命）、存储 Provider/bucket（非致命）
5. Redis 连接（失败降级；成功后执行旧队列迁移 `main.ts:305`–`:306`）
6. 后台任务（`main.ts:313`–`:341`）
7. HTTP 服务与关闭监听（`main.ts:373`、`:376`）

关闭流程（`main.ts:344`–`:371`）：收到 SIGTERM/SIGINT 后先停止新请求并排空（10s 兜底
超时），再 `closeRedisForShutdown()`/`closeDbForShutdown()` 退出。**只有 3 个后台组件**在
关闭流程接线：评测结果消费者（`main.ts:351`）、教学 worker（`:352`）、域存储核对（`:353`）；
教学/存储只调用 `stop()`，未 `await` 其 `done`。

### 6.2 清单

| # | 组件 | 启动点（基线） | 停止/排空现状 | 频率与配置 | 当前归属 → 目标 |
| --- | --- | --- | --- | --- | --- |
| 1 | 评测结果消费者池 | `main.ts:313` → `domains/submission/mq/consumer.ts:282`（池：`:143`） | `requestResultConsumerShutdown()`（`main.ts:351`，`consumer.ts:288` 重导出，实为 `shared/mq/base-consumer.ts:73` 的**全局**停止：会停所有已注册消费者，非实例级） | 队列 `noj:judge:results`（`consumer.ts:27`）；并发 `RESULT_CONSUMER_CONCURRENCY` 默认 4、上限 16（`consumer.ts:30`–`:32`、`:117`–`:123`） | submission → `evaluations`（P2/P4） |
| 2 | 私信审核消费者 | `main.ts:316` → `domains/content-review/mq/review-consumer.ts:104` | 返回的 `ConsumerHandle` 被丢弃（`void createReviewConsumer()()`）；句柄支持实例级 `requestShutdown()` 但未接线 | 队列 `noj:review:dm`（`domains/content-review/services/dm-review.ts:18`） | content-review → `communication`（P2/P4） |
| 3 | 搜索索引消费者 | `main.ts:319` → `domains/search/consumer/search-index-consumer.ts:68` | 句柄被丢弃；`shutdownSearchIndexConsumer()` 存在（同文件）但未在关闭流程调用 | 队列 `noj:search:index`（`shared/search-events.ts:26`） | search → `read-models`（P2/P4） |
| 4 | 队列 sweeper | `main.ts:322` → `domains/submission/mq/sweeper.ts:611` | 无停止接口（`setInterval`，`void` 启动） | 30s（`sweeper.ts:42`）；负责三级队列 processing 重投、pending 提交/自测恢复、终态吊销 outbox 补偿、队列告警 | submission → `evaluations`（P2/P4） |
| 5 | 批任务 worker（管理员重测/用户升级） | `main.ts:325` → `domains/submission/services/versioning/dispatch-job-item.ts:1035` | `stopSubmissionJobWorker()` 已存在（`:1049`）但**未接线** | 3s（`:1024`）；`FOR UPDATE SKIP LOCKED` + lease 续租（`versioning/job-worker.ts:172`） | submission → `evaluations`（P2/P4） |
| 6 | 教学 worker（到期作业发布/进度投影/教学邮件） | `main.ts:326` → `domains/education/services/worker-lifecycle.ts:22`；`educationWorker.stop()`（`main.ts:352`） | 有 `stop()` + `done`，但 `done` 未 await | tick 1.5s（`worker-lifecycle.ts` 内 `waitForTick`）；三个循环：`publishDueAssignments`、`processEducationBatch`、`processEducationEmailBatch(20)`；outbox 消费 `education/services/progress-worker.ts:27`、通知 `notifications.ts:69` | education → `education`（P4 统一持久任务） |
| 7 | 域存储核对（上传补偿/容量核算） | `main.ts:327` → `domains/system/services/storage/domain-reconciliation.ts:62`；`storageReconciliation.stop()`（`main.ts:353`） | 有 `stop()` + `done`，`done` 未 await | 30s 循环 | system/storage → `assets`（P4） |
| 8 | SSE 事件订阅者（Redis Pub/Sub） | `main.ts:330` → `shared/sse/event-bus.ts:215` | 无停止接口（含重连重订阅逻辑） | `PSUBSCRIBE noj:events:*`（前缀定义 `event-bus.ts:12`） | shared/sse → `runtime`（P2） |
| 9 | 审计日志保留 | `main.ts:338` → `domains/system/services/audit-log.ts:202` | 无停止接口 | 启动即跑一次 + 每 24h；配置 `audit_log_retention_days` 默认 90（`shared/config/settings-registry.ts:1015`；`noj-core/.env.example:168`） | system → `platform`（P2） |
| 10 | SSE 事件保留 | `main.ts:341` → `shared/sse/sse-events.ts:92` | 无停止接口 | 启动即跑 + 每 24h；保留 7 天常量（`sse-events.ts:16`） | shared/sse → `runtime`（P2） |
| 11 | 启动期旧队列迁移（一次性） | `main.ts:305`–`:306` → `submission/mq/pool-judge-queue.ts`、`legacy-judge-queue.ts` | 无（幂等，失败策略见 `main.ts` 注释） | 启动时一次；旧单队列/池队列残留迁入新布局 | submission → `runtime`（P2） |
| 12 | Gateway 记账 worker | `noj-llm-gateway/src/app.ts:78` → `accounting.ts:336`（`startAccountingWorker`） | 返回停止函数但被丢弃；Gateway `main.ts`（25 行）无信号监听 | 5s（`accounting.ts:345`）；健康探针当前只 `redis.ping()`（`app.ts:52`–`:65`） | noj-llm-gateway（P5） |
| 13 | Gateway usage retention | `app.ts:77` → `usage.ts:207`（`startUsageRetention`） | 返回停止函数但被丢弃 | 启动即跑 + 每 6h（`usage.ts:164`）；`NOJ_LLM_USAGE_RETENTION_DAYS` 默认 90（`config.ts:45`–`:47`；`noj-llm-gateway/.env.example:61`）；Redis 锁互斥 | noj-llm-gateway（P5） |
| 14 | Judge Worker 主循环 | `noj-judge/src/main.rs:355`（主循环；拉取失败重试间隔 `PULL_RETRY_DELAY` 见 `:33`） | 有 SIGTERM/SIGINT 优雅关闭与 drain 超时（`main.rs:213`、`:333`–`:347`） | 拉取评测队列 → Docker 执行 → 结果投递；启动回放 fallback（`:188`–`:189`）、清理孤儿容器（`:191`–`:192`） | noj-judge（P6） |

### 6.3 停止语义缺口（P2 输入）

- Core 持久循环共 10 个（#1–#10），仅 #1（全局停止）、#6、#7 在关闭流程接线；#2/#3 的
  实例级停止函数未接线，#4/#8/#9/#10 无停止接口，#5 有停止函数未接线。
- 全景约束（方案 §2「后台生命周期」行）："消费者、定时任务和 worker 使用不同停止方式，
  关闭时没有完整等待" → P2 统一为 `ManagedTask { stop(): void; done: Promise<void> }`。
- 多副本语义：当前部署为单副本（[domain-boundaries.md](domain-boundaries.md#多副本约束2026-09-12-架构评审-26)；
  `docker-compose.prod.yml` 无 `deploy.replicas`）。sweeper 的 `_firstSeen`/`_lastRequeue`、
  stats-cache 等进程内状态是已登记的"单副本专用"，新增任务不得再引入进程内可变状态。

### 6.4 后台任务配置项

| 配置 | 当前值/默认 | 定义位置 | 影响 |
| --- | --- | --- | --- |
| `RESULT_CONSUMER_CONCURRENCY` | 4（1–16） | `consumer.ts:30`–`:32`、`:117`–`:123`；`noj-core/.env.example:45` | 评测结果消费者连接数 |
| `JUDGE_QUEUE` | `noj:judge:queue`（bootstrap） | `settings-registry.ts:848`；`judge-queues.ts:18`；`.env.example:230` | 队列前缀，必须与 Judge 一致否则静默积压 |
| `JUDGE_QUEUE_LAYOUT` | `pools`（bootstrap） | `settings-registry.ts`（`JUDGE_QUEUE` 下一项）；`judge-queues.ts:14`；`.env.example:231` | `pools` 分资源池 / `legacy` 协调升级期 |
| `AUDIT_LOG_RETENTION_DAYS` | 90（0=禁用） | `settings-registry.ts:1015`；`noj-core/.env.example:168` | 审计日志清理 |
| `SSE_EVENT_RETENTION_DAYS` | 7（常量，非配置） | `shared/sse/sse-events.ts:16` | SSE 事件清理 |
| `NOJ_LLM_USAGE_RETENTION_DAYS` | 90 | `noj-llm-gateway/src/config.ts:45`–`:47`；`noj-llm-gateway/.env.example:61` | Gateway 用量清理 |
| 评测 sweeper 周期 | 30s（常量） | `submission/mq/sweeper.ts:42` | 队列恢复 |
| 批任务 worker 周期 | 3s（常量） | `dispatch-job-item.ts:1024` | 重测/升级派发 |
| 教学 worker tick | 1.5s（常量） | `education/services/worker-lifecycle.ts` | 教学投影/通知/邮件 |
| 域存储核对周期 | 30s（常量） | `system/services/storage/domain-reconciliation.ts` | 上传补偿/容量核算 |
| 审计/SSE 保留周期 | 24h（常量） | `audit-log.ts:202`、`sse-events.ts:92` | 保留清理 |
| Gateway 记账 tick | 5s（常量） | `accounting.ts:345` | 结算重放/对账 |
| Gateway usage 清理周期 | 6h（常量） | `usage.ts:164` | 用量保留 |

## 7. 代表性基线

### 7.1 请求面：路由目录

- **来源**：`scripts/gen-route-catalog.ts` 扫描 `noj-core/src/routes/*.ts`（当前已不存在）
  与 `noj-core/src/domains/*/routes/*.ts`（不含 `routes/index.ts` 组合文件），用**锚定接收者**
  的正则（`router.get(...)`/`app.post(...)`）提取；生成物为
  [API 路由目录](route-catalog.md)（"请勿手改"）。
- **校验**：`scripts/gen-route-catalog.ts --check` 为 REPO_GATES 之一（`scripts/gate-list.ts:108`）。
- **规模（实测）**：**64 个路由文件 / 355 条路由**。
- **HTTP 方法分布**：GET 183、POST 107、DELETE 28、PUT 22、PATCH 15。
- **按当前域分布**（路由条目数）：admin 109、catalog 49、education 35、identity 34、
  submission 33、community 27、messaging 18、contest 13、query 10、legal 10、system 8、
  objective 4、observability 3、search 2（合计 355）。
- `--check` 输出：`路由目录最新（64 个路由文件 / 355 条路由）`。

### 7.2 事件面：SSE 事件目录

- **来源**：`scripts/gen-event-catalog.ts` 从 `noj-core/src/shared/sse/event-bus.ts`
  提取频道名并扫描 `src/**` 的发布位置，生成 [SSE 事件目录](event-catalog.md)；
  `--check` 为 REPO_GATES 之一（`scripts/gate-list.ts:107`）。
- **规模（实测）**：**9 个频道**：`submission`、`queue`、`user`、`education`、
  `contestRanking`、`contestSubmission`、`stats`、`announcements`、`settings`。
- `--check` 输出：`事件目录最新`。
- 行为约定（引自现有文档）：SSE 仅用于实时提示与重放，REST/数据库事实用于最终校准
  （方案 §4.3）；事件保留 7 天，超期客户端用 REST 全量校准（`sse-events.ts` 注释）。

### 7.3 门禁清单（`scripts/gate-list.ts`，单一事实源）

- 入口：`scripts/check-ci.ts`（CI root-gates job）跑 `REPO_GATES`；
  `scripts/check-all.ts`（本地）跑 `REPO_GATES` + `MODULE_CHECKS`。
- **规模（实测）**：`REPO_GATES` **33** 项、`GATE_SELF_TESTS` **25** 项、
  `MODULE_CHECKS` **3** 项（`gate-list.ts:31`、`:67`、`:167`）。
- 与架构评价直接相关的门禁（部分）：

| 门禁 | 作用 | 定义位置 |
| --- | --- | --- |
| `verify-agent-note-format.ts` | Agent Note 路径/状态/章节格式 | `gate-list.ts:68` |
| `verify-md-links.ts` | Markdown 相对链接与锚点存在性 | `gate-list.ts:69` |
| `verify-capability-seams.ts` | 业务代码不得直接 import Provider 实现 | `gate-list.ts:71` |
| `gen-event-catalog.ts --check` | SSE 事件目录与源码一致 | `gate-list.ts:107` |
| `gen-route-catalog.ts --check` | 路由目录与源码一致 | `gate-list.ts:108` |
| `check-domains.ts` | 域边界/门面导入/深路径规则 | `gate-list.ts:109` |
| `check-migration-safety.ts` | 禁止存量库升级必失败的 `ADD COLUMN NOT NULL` | `gate-list.ts:112` |
| `check-runtime-contract.ts` | 运行时契约 | `gate-list.ts:118` |
| `check-file-size.ts` | 巨型文件棘轮 | `gate-list.ts:129` |
| `check-write-rate-limits.ts` | 写端点限流覆盖 | `gate-list.ts:131` |
| `check-schema-parity.ts`（`cwd: noj-core`） | 手工 DDL 镜像与 Drizzle schema 一致性（P2 将随 PGlite 删除） | `gate-list.ts:144` |

完整的 33 项以 `scripts/gate-list.ts` 为准；本文不复制清单（避免二次维护）。

### 7.4 测试入口命令（基线，本轮未执行）

来源：[测试体系](testing.md)、[CONTRIBUTING](../../CONTRIBUTING.md) 与各模块 `deno.json`。
项目规则：Deno 测试必须通过 `deno task`，禁止手拼 `deno test`。

| 模块 | 命令 | 说明 |
| --- | --- | --- |
| noj-core | `cd noj-core && deno task test` | 串行全量；无 `DATABASE_URL` 时走 PGlite |
| noj-core | `cd noj-core && deno task test:parallel` | 并行分片（需本地 PG；`scripts/test-parallel.ts`） |
| noj-core | `cd noj-core && deno task test:smoke` | 冒烟（Hono + /health，需 Redis） |
| noj-core | `cd noj-core && deno task test:domain <domain>` | 按 Domain（`scripts/test-domain.sh`） |
| noj-core 共享 | `cd noj-core && bash scripts/test-shared.sh` | `tests/shared`/`tests/routes` + smoke |
| noj-core 其他 | `deno task test:pg` / `deno task test:perf` | 真实 PG 全量 / 性能用例（`deno.json` 见下） |
| noj-llm-gateway | `cd noj-llm-gateway && deno task test` | 另有 `test:coverage`、`test:snapshot` |
| noj-ui | `cd noj-ui && deno task test` | 另有 `test:components`、`test:bff:ssr`、`test:bff:cache`、`test:learning:browser` |
| noj-judge | `cd noj-judge && cargo nextest run --all-targets` | 推荐；等价 `cargo test` |
| noj-judge Docker E2E | `NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored` | 需 Docker daemon；其余 e2e_* 同理 |
| noj-tests | `cd noj-tests && deno task test` | 跨模块 E2E（需完整栈） |
| noj-tests 按域 | `cd noj-tests && deno task test:domain <domain>` | 含 `cross-domain` 与 `test:browser` |

`noj-core/deno.json` 中该组任务的当前定义（供对照，非本轮执行结果）：
`test` = `bash scripts/test-all.sh`；`test:smoke` = `deno test -A --no-check tests/smoke.test.ts`；
`test:domain` = `bash scripts/test-domain.sh`；`test:parallel` =
`BCRYPT_SALT_ROUNDS=4 deno run -A --env-file=.env scripts/test-parallel.ts`。

### 7.5 部署与单副本基线

- 生产部署为**单副本**：`docker-compose.prod.yml` 未声明 `deploy.replicas`
  （[domain-boundaries.md](domain-boundaries.md) 多副本约束节）。跨副本共享状态一律走
  Redis/DB；进程内可变状态必须在 `domain-boundaries.md` 的「多副本约束」表登记为
  "单副本专用"（根 [AGENTS.md](../../AGENTS.md) §8.2 红线）。
- 配置分层：runtime（DB-owned，可热改）与 bootstrap（env-owned，启动期定型）的划分与读取链
  见 [配置分层](config-layering.md)；本文 §6.4 的 `JUDGE_QUEUE`/`JUDGE_QUEUE_LAYOUT`/
  `AUDIT_LOG_RETENTION_DAYS` 为 bootstrap 项，其余任务周期是代码内常量。
- Capability Seam 现状见 [Capability Seam](capability-seams.md)（存储/邮件/LLM/搜索）；
  注意该文档仍引用旧路径 `src/lib/storage/types.ts`，当前实际实现位于
  `domains/system/services/storage/`（`types.ts`/`factory.ts`/`local.ts`/`s3.ts`），
  一致性由 `scripts/verify-capability-seams.ts` 门禁守护——列为本轮"待验证"项（§8.1）。

### 7.6 本轮实际执行的验证与命令

| 命令 | 结果 |
| --- | --- |
| `git rev-list --count main..fbc40624` / `...fbc40624..main` | 292 / 28 |
| `jj --ignore-working-copy log -r 'main..@' ... \| wc -l` | 293（含工作副本快照提交） |
| `git merge-base main HEAD` | `e4de4dd0` |
| `git diff --shortstat main...HEAD` / `HEAD...main` | 1539 文件 +202910/−16504 / 152 文件 +7456/−873 |
| `deno run -A scripts/gen-route-catalog.ts --check` | 通过：64 个路由文件 / 355 条路由 |
| `deno run -A scripts/gen-event-catalog.ts --check` | 通过：事件目录最新（9 频道） |
| 表清单提取（§5.1 脚本） | 21 个 schema 文件、109 张表；`ALL_TABLES` 亦 109 |
| `_journal.json` 与 SQL 文件差集 | SQL 120、journal 119；差集仅 `0007_fk_cascade` |
| `gate-list.ts` 导入统计 | REPO_GATES 33 / GATE_SELF_TESTS 25 / MODULE_CHECKS 3 |
| `deno run -A scripts/verify-md-links.ts` | 通过：扫描 877 个 Markdown 文件，0 错误 |
| `deno run -A scripts/verify-agent-note-format.ts` | 通过：格式校验 507 篇，0 错误 |

> 说明：上表最后两行为本文与 Agent Note 定稿时的实际输出；除此之外**没有**运行任何
> 测试、压测或恢复演练（见 §1.3）。

## 8. 交接与维护

### 8.1 待验证/接手事项

| # | 事项 | 依据 | 接手批次 |
| --- | --- | --- | --- |
| 1 | 本地链 `fbc40624` 与 `main` `2f488599` 的协调（含 2 个合并提交、1 条无描述提交 `7b6e8a174`） | §2.1、§2.3 | P8（发布协调） |
| 2 | 后台任务统一停止句柄与"停止后等待完成" | §6.3、方案 §4.2 | P2 |
| 3 | 教学 outbox（`education_outbox`）分阶段迁入统一持久任务 | §5.2、方案 §4.3 | P4 |
| 4 | Gateway ready 探针只 ping Redis（未覆盖 DB 与记账 worker） | §6.2 第 12 行、方案 §2 | P1 |
| 5 | Gateway 无优雅关闭/停止仅丢弃句柄 | §6.2 第 12–13 行 | P5 |
| 6 | `0007_fk_cascade.sql` 不在 journal 的存量例外 | §5.3 | P2/P8 |
| 7 | `capability-seams.md` 存储路径与实际实现（`domains/system/services/storage/`）不一致 | §7.5 | P3（文档随结构调整同步） |
| 8 | 迁移/表数等计数随 P2/P3 变化，本文数字需在批次记录中更新 | §5.1、§5.3 | P2/P3 |
| 9 | 尚未做线上压测/全量测试/恢复演练 | §1.3 | P2/P8 |

### 8.2 P0 完成标准对照（方案 §5）

| 方案要求 | 本文落点 |
| --- | --- |
| 固定受审版本 | §1.1、§2.1（`fbc40624`，main `2f488599`，分叉 `e4de4dd0`） |
| 登记模块所有权 | §3（17 现域）、§4（12 目标分区映射） |
| 登记表所有权 | §5（109 表 / 21 schema 文件 / 迁移链基线） |
| 登记后台任务所有权 | §6（14 个组件 + 配置项 + 停止语义缺口） |
| 记录代表性请求/查询/行为基线 | §7（路由 355、事件 9、门禁 33+25+3、测试入口、单副本） |
| 当前本地 UI 提交与 main 归属清楚、不夹带未说明既有工作 | §2.2、§2.3、§2.4 |
| 本轮未做线上压测/全量测试/恢复演练需注明 | §1.3、§7.6 |

### 8.3 维护约定

- 本文是 **P0 时点快照**：不回溯修改既有数字；后续批次改变分区/表/任务时，在批次
  记录或新快照中登记差异，必要时在本文件对应节追加"更新指针"（沿用 README 时效约定）。
- 本文未加入 [工程规范 README](README.md) 的常青索引（P0 约束：不修改既有文档）；
  引用入口为方案 §7 跟踪清单与
  [Agent Note：冻结架构基线](../../.agents/notes/implemented/architecture/2026-10-20-architecture-baseline-freeze.md)。
- 新增/迁移表、后台任务或模块时，按方案 §3.2/§4 的依赖规则同步更新本文件的对应清单，
  并用同一组命令复测（§2.4、§5.1、§7.1、§7.6）。

## 9. 快速索引（本文引用的关键文件）

- 方案：[架构整治方案](../superpowers/plans/2026-10-20-architecture-remediation.md)
- 版本：[main.ts](../../noj-core/src/main.ts)、[app.ts](../../noj-core/src/app.ts)、
  [schema/index.ts](../../noj-core/src/shared/db/schema/index.ts)、
  [schema.ts](../../noj-core/src/shared/db/schema.ts)、
  [drizzle meta](../../noj-core/drizzle/meta/_journal.json)
- 后台任务：`domains/submission/mq/consumer.ts`、`domains/submission/mq/sweeper.ts`、
  `domains/submission/services/versioning/dispatch-job-item.ts`、
  `domains/education/services/worker-lifecycle.ts`、
  `domains/system/services/storage/domain-reconciliation.ts`、
  `domains/system/services/audit-log.ts`、`shared/sse/event-bus.ts`、
  `shared/sse/sse-events.ts`、`shared/mq/base-consumer.ts`、
  `noj-llm-gateway/src/app.ts`、`noj-llm-gateway/src/accounting.ts`、
  `noj-llm-gateway/src/usage.ts`、`noj-judge/src/main.rs`
- 门禁与生成物：`scripts/gate-list.ts`、`scripts/gen-route-catalog.ts`、
  `scripts/gen-event-catalog.ts`、[API 路由目录](route-catalog.md)、
  [SSE 事件目录](event-catalog.md)、[测试体系](testing.md)
- 既有所有权文档：[域边界与所有权](domain-boundaries.md)、[配置分层](config-layering.md)、
  [Capability Seam](capability-seams.md)、
  [系统架构评审（2026-09-12）](architecture-review-2026-09-12.md)
