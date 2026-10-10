# 临时任务跟踪：题目版本管理实施

> ⚠️ **本文件是实施期的临时进度跟踪，目标交付完成后必须删除**（见文末「交付前删除清单」）。
> 详细设计规则以《Neuro OJ 题目版本管理实施 Handbook》为准；长期证据记录见
> [`dev-docs/superpowers/plans/2026-10-09-problem-version-management.md`](../../dev-docs/superpowers/plans/2026-10-09-problem-version-management.md)。
>
> 维护方式：每完成一个可验证的最小单元就更新本文件（状态 + 证据 + 下一步），
> 使任何一轮中断后都能从本文件直接续接。

- 目标分支：`feat/problem-version-management`（GPG 签名，禁止直推 main）
- 当前轮次：goal round 24
- 最近更新：批次 6 客户端（CLI/IDE/E2E 完成，noj-ui 进行中）

## 一、批次状态总览

| # | 批次 | 状态 | 备注 |
|---|---|---|---|
| 1 | 基础模型（schema/类型/纯计算器/PGlite DDL/迁移 0102） | ✅ 完成 | parity 68 表/613 列 |
| 2 | 版本写入（草稿、发布、文件引用、OI、客观题快照） | 🟡 部分 | 2a/2b/2c（OI 核心）/2d/2e（创建即建草稿+删除清理+路由）完成；剩 2c 收尾、2e 收尾 |
| 3 | 评测链路（attempt、协议、结果事务、LLM、sweeper、自测） | ✅ 完成 | 含协议 v2、contest 口径修复、LLM attempt 作用域 |
| 4 | 管理操作（策略、批任务、重测、升级） | ✅ 完成 | 派发 + 路由 + 旧入口适配层；仅「代他人升级」旁路未做 |
| 5 | 读取统一（通过状态、题单、排行、资料、社区、搜索、正式成绩） | 🟡 部分 | 5a/5b/5c 主体完成；剩 stats-cache、search 索引、5d 快照 |
| 6 | 客户端（Web、IDE、CLI、演练） | 🟡 部分 | CLI/LMCC/E2E 完成；noj-ui Web 端进行中 |
| 7 | 存量收尾（回填、旧表删除、视图/索引重建、备份恢复验证） | 🟡 部分 | 0103 回填 + 真实库演练完成；剩 7b |
| 8 | 文档与交付（现行文档、Agent Note、验收、PR） | ⬜ 未开始 | 含删除本跟踪文件 |

图例：✅ 完成　🟡 部分　⬜ 未开始

## 二、逐项清单（未完成项）

### 批次 2（版本写入）
- [ ] 2c 收尾：OI 路由改走 `saveOiDraft`（`oi-author.ts`）；ZIP worker 结果绑定 revision；
      OI 自测从版本构造临时包并登记临时对象引用。
- [ ] 2e 收尾：`updateProblem` 管理信息与内容分离（内容写草稿、不直接改投影）——
      必须与 2c 的 OI 草稿路径切换同步落地，否则 OI 保存会「只落草稿不生效」。
- [ ] 题包导入的客观题小题直接写草稿（当前仍写旧 `objective_questions` 表后同步）。

### 批次 5（读取统一）
- [ ] `query/services/stats-cache.ts`：删除进程内增量计数与 `_hasViewCache`/刷新节流模块状态，
      改 revision 键控的数据库聚合 + Redis 缓存（多副本约束）。
- [ ] `search/services/index-writer.ts`：发布后索引**公开版本内容**，草稿不入公开索引。
- [ ] 5d 正式成绩快照：结算时记录每题版本策略、有效尝试与提交时间；修订走新快照。

### 批次 6（客户端 · noj-ui）
- [ ] `composables/`：版本/草稿/发布/批任务 API 封装（含幂等键、终态轮询、SSE 后重取）。
- [ ] `pages/problems/[id].vue`：版本选择 + 「当前通过要求」提示 + 提交携带 `version_id`。
- [ ] `components/editor/*`：保存草稿 / 发布版本两个动作，统一草稿 revision。
- [ ] `components/objective/ObjectiveProblemEditor.vue`：小题写草稿、稳定 key、整卷发布。
- [ ] `pages/contests/[contestId]/problems/[label].vue`：固定版本作答；409
      `CONTEST_PROBLEM_VERSION_CHANGED` 保留已写内容并提示刷新。
- [ ] `pages/submissions/index.vue` / `[id].vue`：版本与有效性筛选、批量升级入口、
      提交时版本 / 各版本当前判定 / 来源关联展示。
- [ ] `pages/admin/*`：三种重测范围、固定版本映射、独立策略切换、任务进度与重试。

### 批次 7（存量收尾）
- [ ] 大库分批重算投影（`recomputeProblemProjections` 当前逐条）。
- [ ] `contest_problems.pinned_version_id` 最终 `SET NOT NULL`。
- [ ] 删除旧表 `evaluation_results`、`objective_questions`（运行期读取已迁完的项目先删）。
- [ ] 重建用户榜单物化视图与搜索索引；备份/恢复演练验证。

### 批次 8（文档与交付）
- [ ] 新增用户/管理员版本管理文档（草稿发布、提交时版本、any/exact、升级/重测/进度、
      客观题标识与强行重判、产物保留与历史缺失）。
- [ ] 同步现行文档：根 README/AGENTS、题型与出题指南、题包规范与 `--publish`、
      题单/提交/竞赛/重测说明、生产升级与备份恢复文档。
- [ ] 新增或更新 implemented Agent Note（有效成绩物化、独立作用域、跨版本保留、协调升级）。
- [ ] 全量验收：core 各域 + shared + judge + gateway + UI + E2E；迁移安全与真实库演练。
- [ ] PR：从 `feat/problem-version-management` 合入 `main`（GPG 签名、CI 全绿）。
- [ ] **删除本跟踪文件**（见文末清单）。

### 已知偏差 / 待收紧
- [ ] `resolveSubmissionVersion` 对「题目尚未发布任何版本」的存量题目仍返回
      `legacy_unknown`；批次 7 基线回填完成后收紧为拒绝。
- [ ] `rejudgeProblemSubmissions` 整题范围仍按 `submitted` 目标受理（适配层），
      界面「统一用 V3」需通过 `specified` 目标走统一任务服务。
- [ ] `acceptUpgradeJob` 尚无管理员旁路（管理入口「代他人升级」）。

## 三、最近验证证据

| 范围 | 命令 | 结果 |
|---|---|---|
| noj-core 全量 | `cd noj-core && deno task test:parallel` | **1388 passed / 0 failed / 11 ignored** |
| catalog 域 | `bash scripts/test-domain.sh catalog` | **301 passed / 0 failed** |
| submission 域 | `bash scripts/test-domain.sh submission` | **219 passed / 0 failed / 21 ignored** |
| identity 域 | `bash scripts/test-domain.sh identity` | **310 passed / 0 failed / 25 ignored** |
| admin 域 | `bash scripts/test-domain.sh admin` | **14 passed / 0 failed** |
| noj-judge | `cargo nextest run --all-targets` | **554 passed / 45 skipped** |
| llm-gateway | `deno task test` | **99 passed / 0 failed / 1 ignored** |
| 静态门禁 | lint / fmt / 域边界 / JSDoc / parity / 迁移安全 / 快照链 | 全绿 |

- 真实 PostgreSQL 存量演练（0102+0103）：7 基线 / 123 legacy 尝试 / 123 未知桶判定 /
  123 有效投影，与旧读取口径 **0 差异**；开发库已升级。
- 提交历史：**41 个 GPG 签名提交**在 `feat/problem-version-management`，工作副本干净。
- 环境注意：`noj-lmcc-extension` 的 `npm run check` 因缺 `@types/node` 与
  `moduleResolution=node10` 弃用报错（预先存在，非本次改动引入）。

## 四、下一步（按优先级）

1. **noj-ui 客户端**（批次 6 主体）：先做 composables，再题目详情页版本选择与提交携带版本，
   然后编辑器草稿/发布、管理页三种重测范围与策略切换、提交列表/详情版本展示。
2. 2c/2e 收尾（OI 草稿路径 + `updateProblem` 内容写草稿）。
3. 批次 5 收尾（stats-cache 去进程内状态、搜索索引发布内容、正式成绩快照）。
4. 批次 7b 与批次 8（文档、Agent Note、验收、PR），最后删除本文件。

## 五、交付前删除清单（本文件生命周期的收口）

1. 批次 8 全部完成后：`rm .agents/tasks/problem-version-management.md`（并删除空的
   `.agents/tasks/` 目录）。
2. 确认仓库无其它引用：`rg -n "problem-version-management.md" --hidden` 只在
   `dev-docs/` 的实施计划中出现（计划文档本身是长期交付物，保留）。
3. 确认该文件未进入任何提交：`jj log --no-graph -r 'all()' -T 'description' | rg -n "临时任务跟踪"`。
4. 交付 PR 前最后一遍：`jj status` 干净、`git log --show-signature -1` 为 `G`。
