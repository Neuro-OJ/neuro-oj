# 出题人与选手体验增强设计（风控接线 / 数据洞察 / 官方题解与赛后复盘）

Status: approved（设计已由项目所有者逐节确认）
日期：2026-09-14
范围：noj-core（catalog / contest / community / search）、noj-ui、noj-docs
基线：main @ b318aa1c3（0.9.5，公测准备期）

---

## 1. 背景与目标

项目当前处于"工程化成熟期"，主要矛盾不在架构选型，而在若干**能力已建成但未投入使用**、
以及**内容侧数据不可观测**。本设计只做三件事，均服务于"出题人把题发好、选手把题学透"：

| 编号 | 工作流 | 一句话 |
| --- | --- | --- |
| W1 | 风控接线 | 相似度检测结果对管理员可见、可复核 |
| W2 | 数据洞察 | 通过率对所有人公开（赛中除外）；出题人可看用例失败分布 |
| W3 | 官方题解 + 赛后复盘 | 官方题解可标识；竞赛赛期不泄题解，赛后出复盘入口 |

三个工作流**可独立交付、独立回滚、独立验收**，建议按 W1 → W2 → W3 顺序实施。

### 1.1 非目标（明确不做）

- 题解进题包（Problem Bundle）：**已否决**，题解走社区内容形态。
- 题解版本化、题解 AI 生成、题解评分体系。
- 题目难度自动标定（`difficulty` 维持自由文本）。
- 多语言评测（项目已确认为决策性不做项）。
- 考试模式、认证发证、IOI/ICPC 赛制（属其他里程碑，不在本设计内）。

---

## 2. 现状证据（均为实测，非推断）

| 事实 | 证据 |
| --- | --- |
| 相似度检测后端完整，前端未接线 | 端点 `noj-core/src/domains/admin/routes/contest.ts:504`；DTO `contest/services/contest-similarity.ts:906`；`noj-ui/composables/useContests.ts` 仅有 `listAntiCheatGroups`/`listAntiCheatTimeline` |
| 风控面板只有 IP 维度 | `noj-ui/pages/admin/contests.vue:646` 起的风控弹窗 |
| 题目无任何统计字段 | `noj-core/src/shared/db/schema/catalog.ts:27` 起，`problems` 表仅 `difficulty`（自由文本） |
| 用例级结果从不聚合 | `evaluation_results.details`（`schema/submission.ts:109`，`text` 存 JSON）；judge 侧用例结构 `noj-judge/src/types.rs:202` |
| 隐藏用例判定口径已存在 | `submission/services/submissions/submission-projection.ts:119-133`（`hidden === true` 或 `visibility === "hidden"`） |
| 题解已存在但无官方标识 | `community_posts.type` 含 `solution`（`schema/community.ts:100`）；发布需先 AC（`community/services/community/community-post-crud.ts:49`） |
| **题解完全不感知竞赛窗口** | `community-post-list.ts:58` 仅按 `problem_id` 过滤；community 域全仓无 contest 引用 |
| **竞赛只允许公开题入赛** | `contest/services/contests.ts:255`（非管理员仅可加入公开题或自有题） |
| 竞赛状态判定已有工具 | `contest/services/contests.ts:322` `computeContestStatus`；访问校验 `contest/services/contest-access.ts:55`（running/ended 放行） |
| 出题人身份判定已有统一点 | `catalog/services/problem-access.ts:52` `resolveProblemAccess`（owner / admin / contest / public） |

### 2.1 由此确认的真实缺陷（W3 必须处理）

题解读路径与竞赛窗口**没有任何关联**，而竞赛只允许公开题入赛 ⇒
**竞赛进行中，选手在题目页可以读到该题已存在的题解**。发布门槛（需先 AC）只约束
"没做过的人发不了"，不约束"别人早就写好了"。这是 F-03 同类剧透面的读侧残余。
W3 的门控即为此而设。

---

## 3. 共享依赖（W2 与 W3 复用，必须先建）

### 3.1 题目暴露判定

新增 `noj-core/src/domains/contest/services/problem-exposure.ts`，经
`contest/index.ts` 门面导出：

```ts
/** 该题当前是否处于"进行中竞赛"的暴露期。 */
export async function isProblemInRunningContest(problemId: string): Promise<boolean>;

/** 批量版本：一次查询判定多个题目，供列表/搜索路径使用。 */
export async function filterProblemsInRunningContest(
  problemIds: string[],
): Promise<Set<string>>;
```

判定口径：存在任一 `contest_problems` 行，其关联 `contests` 满足
`start_time <= now < end_time`（等价于 `computeContestStatus(...) === "running"`）。

**设计取舍（有意为之）**：**不使用缓存、不引入调度任务**。时间窗口实时比较，
竞赛开始/结束无需任何状态翻转动作。这样不新增进程内可变状态，不触碰
[`domain-boundaries.md`](../engineering/domain-boundaries.md#多副本约束2026-09-12-架构评审-26)
的多副本约束表。查询走 `contest_problems(contest_id, problem_id)` 主键与
`contests` 主键，成本为索引点查。

表 `contest_problems` / `contests` 归 contest 域，该判定逻辑归属正确；
catalog / community / search 通过门面调用，不深路径 import。

---

## 4. W1：风控接线

### 4.1 目标

管理员从"看到可疑"到"能复核"的闭环打通。**后端零改动**。

### 4.2 接口契约

`noj-ui/composables/useContests.ts` 新增：

```ts
listAntiCheatSimilarSubmissions(contestId: string, query?: {
  threshold?: number;   // (0, 1]，默认 0.8
  limit?: number;       // 1-200，默认 50
  problem_id?: string;  // UUID 或 display_id
}): Promise<{
  data: SimilarSubmissionPair[];
  meta: {
    threshold: number; limit: number; total: number;
    truncated: boolean; candidates: number; participating: number;
    skipped: number; buckets: number; max_submissions: number;
  };
  data_policy: { purpose: string; retention_days: number; automated_penalty: boolean };
}>;
```

`SimilarSubmissionPair` 字段严格对齐 `contest-similarity.ts:906`：`submission_a_id`、
`user_a_id`、`username_a`、`submitted_at_a`、`submission_b_id`、`user_b_id`、
`username_b`、`submitted_at_b`、`problem_id`、`language`、`similarity`、
`shared_fingerprints`、`fingerprint_count_a`、`fingerprint_count_b`。
**响应不含源代码**，前端不得假设有源码字段。

### 4.3 UI

`noj-ui/pages/admin/contests.vue` 风控弹窗内新增分栏：**IP 关联** / **相似提交**。

- 相似提交侧控件：阈值滑杆（默认 0.8）、题目筛选、刷新。
- 必须展示 `meta` 的解释性数字：`threshold`、`truncated`、`participating`、`skipped`、
  `candidates`。**理由**：后端为此专门返回这些字段（`admin/routes/contest.ts:517-530`），
  不展示会让管理员把"没算到"误读成"没有相似提交"。
- 每行提供"查看提交详情"跳转，复用既有
  `GET /api/v1/admin/submission/submissions/:id`（`domains/admin/routes/submission.ts:92`，含 code）。
- 保留 `data_policy.automated_penalty = false` 的横幅文案（与 IP 面板同款措辞）。
- `truncated === true` 时必须显式提示"结果已按上限截断，请缩小范围（按题目筛选）"。

### 4.4 文件

| 文件 | 变更 |
| --- | --- |
| `noj-ui/composables/useContests.ts` | 新增 1 个函数 + 导出类型 |
| `noj-ui/pages/admin/contests.vue` | 新增 tab 与列表（当前 661 行，不超过 1200 行棘轮） |
| `noj-ui/utils/i18n.ts` | 新增文案（zh-CN / en-US 两套） |
| `noj-ui/tests/contestAntiCheat_test.ts` | 追加相似对 DTO 形状契约测试 |

### 4.5 测试

照既有 `contestAntiCheat_test.ts` 模式（纯类型/字段形状断言）追加一条：断言语义为
"相似对 DTO 仅包含人工复核所需的最小字段"，并显式断言**不含** `code` / `source` 字段。

---

## 5. W2：出题人数据洞察

### 5.1 目标

通过率**对全体做题人公开（竞赛进行中除外）**；用例失败分布等深度指标仅题目 owner 与管理员可见。

### 5.2 端点

| 方法 | 路径 | 权限 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/v1/problems/:id/stats/public` | 公开 | `attempt_count`、`submit_count`、`accepted_count`、`acceptance_rate` |
| GET | `/api/v1/problems/:id/stats` | 题目 owner 或 `problem:read` 管理员 | 公开部分 + `status_distribution` + `case_failure_distribution` + `first_ac_median_ms` + `sample_size` + `truncated` + `window_days` |

放在 catalog 域（`problems` 表归它），新增
`noj-core/src/domains/catalog/services/problems/problems-stats.ts`，
避免把 `problems-crud.ts` 继续撑大。

### 5.3 公开通过率的赛中门控

`/stats/public` 在 `isProblemInRunningContest(problemId) === true` 时返回
`acceptance_rate: null` + `suppressed_reason: "running_contest"`，
其余计数字段照常返回（提交数本身不构成优势）。前端展示"竞赛进行中暂不显示通过率"。

**理由**：通过率是"这题有多难"的信号，赛期公开等于给出题目难度先验。
竞赛结束（`ended`）后自动恢复，无需任何调度。

### 5.4 聚合口径

`evaluation_results.details` 是 `text` 存 JSON，**无法直接 SQL 聚合**。

- 取数：按 `problem_id` 过滤 `submissions`（有 `idx_submissions_problem_id`），限定时间窗（默认近 90 天，可用 `window_days` 覆盖），上限 **2000 条**提交。
- 超出上限：返回 `truncated: true` + `sample_size`，**不静默截断**
  （沿用 `contest-similarity.ts` 对 `SIMILARITY_SCALE_EXCEEDED` 的既有取舍：
  对洞察类功能，静默截断会让"没算到"被误读为"没问题"）。
- 仅统计 `status = 'finished'` 且有 `evaluation_results` 行的提交。
- 中位数计算：对首次 AC 耗时取中位数（非均值，避免长尾拉偏）。

### 5.5 隐藏用例的处理（硬约束）

- 复用 `submission-projection.ts` 的 `isHidden` 判定（`hidden === true || visibility === "hidden"`）。
- **隐藏用例只计入匿名聚合桶**（`hidden-1`、`hidden-2`…按出现顺序稳定编号，跨请求编号一致），
  **不得**返回真实 `case_id`，不得返回输入/期望/实际输出。
- 可见用例返回真实 `case_id`。
- 该约束的意图：用例失败分布是出题人调数据的依据，但隐藏用例的身份本身属于评测面信息。

### 5.6 缓存

结果按 `problem_id` 缓存 **5 分钟**。该缓存为**进程内状态**，必须登记进
[`domain-boundaries.md`](../engineering/domain-boundaries.md#多副本约束2026-09-12-架构评审-26)
的「多副本约束」表，标注"单副本专用"（与既有 `stats-cache.ts` 同口径）。

### 5.7 UI

- `noj-ui/pages/admin/problem-edit/[id].vue` 新增"数据"标签页：状态分布、用例失败分布（条形）、
  首次 AC 中位耗时、`sample_size` / `truncated` / `window_days` 说明。
- 题面页 `noj-ui/pages/problems/[id].vue`：对 owner 显示进入"数据"页的入口；
  对全体用户显示公开通过率（赛中隐藏）。

### 5.8 文件

| 文件 | 变更 |
| --- | --- |
| `noj-core/src/domains/catalog/services/problems/problems-stats.ts` | 新增（聚合 + 缓存） |
| `noj-core/src/domains/catalog/routes/problems.ts` | +2 路由（当前 575 行） |
| `noj-core/src/domains/contest/services/problem-exposure.ts` | 新增（§3.1） |
| `dev-docs/engineering/domain-boundaries.md` | 登记缓存为单副本专用 |
| `noj-ui/pages/admin/problem-edit/[id].vue`、`noj-ui/pages/problems/[id].vue`、`noj-ui/utils/i18n.ts` | UI 与文案 |

### 5.9 测试

- `cd noj-core && deno task test:domain catalog`
  - owner 可读 `/stats`、非 owner 403、管理员可读；
  - `/stats/public` 匿名可读；
  - **隐藏用例不出真实 `case_id`**（断言返回体中不含隐藏用例 id）；
  - 超过 2000 条时 `truncated === true` 且 `sample_size` 准确；
  - 赛中进行中的题目 `/stats/public` 返回 `acceptance_rate: null`。
- 聚合纯函数单测：状态分布、失败分布、中位数（含空集与偶数个样本）。
- `cd noj-core && deno task test:domain contest`：`problem-exposure` 的
  pending/running/ended、多竞赛并存（取并集）用例。

---

## 6. W3：官方题解 + 赛后复盘 + 堵剧透

### 6.1 官方题解标识

- `community_posts` 新增列 `is_official boolean NOT NULL DEFAULT false`。
  **带 `DEFAULT`，符合迁移安全门禁**（`scripts/check-migration-safety.ts` 只拦
  "无 DEFAULT 的 NOT NULL"），无需三步式。
- 迁移由 `deno task db:generate` 生成；新增索引
  `idx_community_posts_official (problem_id, is_official, created_at)` 支撑置顶排序。
- 置官方权限：**题目 owner 或审核员**。实现时确认 catalog 门面是否已导出等价于
  `resolveProblemAccess` 的 owner 判定；若没有，在 `catalog/index.ts` 补一个只读断言函数
  （禁止 community 深路径 import catalog）。
- 排序：题解列表 `is_official DESC, created_at DESC`；题目页题解区
  （`noj-ui/pages/problems/[id].vue:354` 起）官方题解置顶 + "官方题解"徽章。
- 发布入口允许 holder 勾选"标记为官方题解"；未持权者的勾选被服务层拒绝
  （不得只靠前端隐藏）。

### 6.2 赛期题解门控（读路径）

对"属于进行中竞赛的题目"（§3.1），**题解类帖子整体不可见**，且**对包括发布者本人在内的
所有普通用户不可见**（避免通过自视图形成侧信道确认）。审核员与管理员不受限（复核需要）。

覆盖路径：

| 路径 | 位置 |
| --- | --- |
| 题解列表 | `community/services/community/community-post-list.ts`（`listPosts`） |
| 单帖详情 | 同文件 `getPost`（路由 `community/routes/community.ts:245`） |
| 类型计数 | `countPostsByType`（路由 `:205`） |
| 收藏列表 | `listBookmarks` |
| 动态流 | `community/services/community/community-feed.ts` 的 `solution_published` 事件 |

统一在**服务层**实现，不在路由层——路由层门控是 F-05 类缺陷的既有教训。

### 6.3 赛期题解门控（搜索路径）

`noj-core/src/domains/search/services/permission-filter.ts` 增加自包含 SQL 谓词：

排除满足以下全部条件的 `search_entries` 行：`entity_type = 'community_post'`
且 `metadata->>'post_type' = 'solution'` 且
`metadata->>'problem_id' IN (正在进行的竞赛的题目集合)`。

- 需要的 `post_type` / `problem_id` 已在 `search/services/index-writer.ts:226-232` 的
  `metadata` 中，**无需重建索引、无需迁移**。
- 时间窗口在 SQL 内实时比较，**无需调度**；竞赛结束后自动放行。
- 该谓词必须保持自包含（不依赖调用方传入题目集合），与既有
  `permissionWhere` / `communityVisibilityWhere` 同构。

### 6.4 发布路径

`GET /api/v1/community/solutions/eligibility`（`community/routes/community.ts:215`）
在门控期返回 `can_create: false`，并新增 `blocked_reason: "running_contest"`。
前端题目页发布按钮显示禁用态与原因文案（"竞赛进行中，赛后开放题解"），
而非让用户点击后吃 403。

### 6.5 赛后复盘

竞赛详情页在 `ended` 时展示"赛后复盘"分区：题目列表 + 每题官方题解入口 + 本人提交结论。
权限沿用既有 `verifyContestAccess`（`contest/services/contest-access.ts:55`：`ended` + 参赛者放行），
**不新增权限判定、不新增端点**（复用竞赛题目列表与社区题解列表）。

### 6.6 已接受的代价（Consequences）

某道题若既是"正在进行的竞赛题"又是日常练习题，其题解会在赛期对**所有人**隐藏。
这是为堵住 §2.1 剧透面所付的代价。运营侧缓解方式：日常练习题避免与竞赛题复用同一题目记录，
或在赛期接受该题的题解暂不可见。

### 6.7 文件

| 文件 | 变更 |
| --- | --- |
| `noj-core/src/shared/db/schema/community.ts` | +`is_official` 列 + 索引 |
| `noj-core/drizzle/00XX_*.sql` | 由 `deno task db:generate` 生成 |
| `noj-core/src/domains/community/services/community/community-post-list.ts` | 门控 + 排序 |
| `noj-core/src/domains/community/services/community/community-feed.ts` | 门控 |
| `noj-core/src/domains/community/routes/community.ts` | eligibility `blocked_reason` |
| `noj-core/src/domains/search/services/permission-filter.ts` | 搜索谓词 |
| `noj-core/src/domains/contest/services/problem-exposure.ts` | 复用 §3.1 |
| `noj-ui/pages/problems/[id].vue`、`noj-ui/pages/contests/[contestId]/index.vue`、`noj-ui/utils/i18n.ts` | UI 与文案 |
| `noj-docs/docs/features/contests.md`、`noj-docs/docs/reference/changelog.md` | 文档 |

### 6.8 测试

- `cd noj-core && deno task test:domain community`：
  - 赛期题解在 `listPosts` / `getPost` / `countPostsByType` / bookmarks / feed **五条路径**均不可见；
  - 赛后同一批数据全部可见；
  - 发布者本人在赛期亦不可见；
  - 审核员与管理员的例外生效。
- `cd noj-core && deno task test:domain search`：赛期搜索不到题解、赛后能搜到。
- eligibility：赛期 `can_create === false` 且 `blocked_reason === "running_contest"`。
- 迁移安全门禁：`deno run -A scripts/check-migration-safety.ts`。

---

## 7. 验收标准

| 编号 | 可执行验收动作 |
| --- | --- |
| W1 | 管理员在竞赛风控弹窗切换到"相似提交"，能看到成对提交与相似度；`truncated` 时出现截断提示；点击行可跳转到含 code 的提交详情 |
| W2 | 匿名访问题目页可见通过率；把该题加入一场进行中的竞赛后，通过率位置显示"竞赛进行中暂不显示"；题目 owner 的"数据"页能看到状态分布与用例失败分布，**且隐藏用例无真实 case_id** |
| W3 | 造一场进行中的竞赛并含某公开题：该题已有题解时，赛期题目页题解区为空、搜索无结果、发布按钮禁用；竞赛结束（改 `end_time` 到过去）后题解立即恢复可见 |
| 全量 | `deno run -A scripts/check-ci.ts` 通过；`cd noj-core && deno task test:domain <受影响域>` 通过 |

---

## 8. 工程纪律（本设计必须遵守的既有规则）

- 迁移：禁止无 `DEFAULT` 的 `NOT NULL` 新增列（本设计的 `is_official` 带默认值，合规）。
- 多副本：新增进程内缓存（W2 的 5 分钟统计缓存）必须登记 `domain-boundaries.md`。
- 跨域：只允许 import 其他域 `index.ts` 门面；`observability` 为受限域，本设计不得触碰。
- 测试：必须用 `deno task test:domain <domain>`，禁止手拼 `deno test`。
- 提交：中文描述 + Conventional Commits + GPG 签名；非平凡变更需 Agent Note。
- 文件规模：`check-file-size.ts` 阈值 1200 行，改动文件不得越过棘轮。
- 文档：API 行为变更同步 `noj-docs`；新增路由由 `gen-route-catalog` 覆盖。

---

## 9. 实施顺序与交付切分

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| W1 | 风控接线（纯前端） | 无 |
| W2a | §3.1 题目暴露判定 + `/stats/public` | 无 |
| W2b | `/stats` 深度聚合 + 管理端数据页 | W2a |
| W3a | `is_official` 迁移 + 官方题解标识与排序 | 无 |
| W3b | 赛期题解门控（读 + 搜索 + 发布） | §3.1 |
| W3c | 赛后复盘入口 | W3b |

每个阶段单独 PR、单独验收、单独回滚。
