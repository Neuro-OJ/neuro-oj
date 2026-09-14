# Agent Note: 出题人与选手体验增强（风控接线 / 数据洞察 / 官方题解与赛期门控）

Status: implemented

## Problem

三个相对独立、但都指向"已具备的能力没有真正服务于人"的问题：

1. **风控成果对管理员不可见**。竞赛代码相似度检测的后端早已完整
   （`domains/admin/routes/contest.ts` 的 `similar-submissions` 端点、
   `domains/contest/services/contest-similarity.ts` 的 `SimilarSubmissionPair`），
   但前端 `noj-ui/composables/useContests.ts` 只接了 `ip-groups` 与 `timeline`，
   风控面板（`noj-ui/pages/admin/contests.vue`）也没有相似提交分栏 ——
   管理员能看到"谁和谁同 IP"，看不到"谁抄了谁"，#490 的成果实际等于零可用。

2. **出题人对自己的题一无所知**。`problems` 表只有自由文本 `difficulty`，
   没有任何统计列；`evaluation_results.details.cases[]` 里的用例级结果
   （`noj-judge/src/types.rs` 的 `CaseResult`）**从未被聚合**。出题人无法回答
   "这题多少人做了""大家卡在哪个用例"。

3. **题解读路径不感知竞赛窗口（真实缺陷）**。`community-post-list.ts` 的题解
   查询只按 `problem_id` 过滤，community 域全仓没有任何 contest 引用；
   而竞赛加题约束（`contest/.../contests.ts` 的 `assertContestProblemAddable`）
   **只允许公开题入赛**。两者组合的后果：**竞赛进行中，选手在题目页可以读到
   该题已存在的人肉题解**。题解发布门槛（需先 AC）只约束"没做过的人发不了"，
   完全不约束"别人早就写好了"。

## Decision

**W1 风控接线**：前端补齐相似提交分栏。DTO 契约与展示辅助放在
`noj-ui/utils/contestAntiCheat.ts`（纯逻辑，可被 deno test 断言），
composable 只保留 `api.get` 调用；面板给阈值滑杆、按该场竞赛题目筛选、
并**必须展示** `participating`/`candidates`/`skipped`/`truncated` ——
后端专门返回这些字段，不展示会让管理员把"没算到"误读为"没有相似提交"。
复核跳转复用既有的管理端提交详情端点（含 code），不新增接口。

**W2 数据洞察**：新增 `catalog/services/problems/problems-stats.ts`。
- `GET /problems/:id/stats/public`：匿名可读，**通过率对所有人公开**；
  竞赛进行中的题目返回 `acceptance_rate: null` + `suppressed_reason: "running_contest"`
  （通过率是难度先验，赛期公开等于泄题；提交数不构成榜单优势，故不抑制）。
- `GET /problems/:id/stats`：仅题目 owner 或 `admin:full_access`。
- 隐藏用例**只进匿名聚合桶**（`hidden-N`），复用
  `submission-projection.ts` 的 `isHidden` 同一口径，真实 `case_id` 绝不外泄。
- 取数上限 2000 条，超出返回 `truncated: true`（**不静默截断**，
  沿用相似度检测 `SIMILARITY_SCALE_EXCEEDED` 的既有取舍）。
- 进程内 5 分钟缓存，已登记 `domain-boundaries.md` 多副本约束表。

**W3 官方题解与赛期门控**：
- `community_posts` 新增 `is_official`（带 DEFAULT，迁移安全）；
  置官方权限为**题目 owner 或审核员**，在**服务层**强制；
  普通用户传 `is_official: true` 被静默忽略（不报错，避免探测题目归属）。
- **赛期门控**由 `contest/services/problem-exposure.ts` 统一判定
  （`isProblemInRunningContest` / `filterProblemsInRunningContest`），
  纯按 `start_time <= now < end_time` 实时计算，**不引入缓存或调度任务**：
  竞赛开始/结束无需任何状态翻转动作。
- 门控覆盖**五条读路径**：`listPosts`、`getPost`、`countPostsByType`、
  `listBookmarks`、`listFeed` 的 `solution_published` 活动；
  外加搜索路径（`permission-filter.ts` 新增自包含谓词，
  接入 `searchFlat` 与 `searchGrouped`）。
  全部在**服务层/SQL 层**实现，不在路由层（F-05 类缺陷的教训）。
- 门控包含**发布者本人**：避免"自己能看到 = 该题有题解"的侧信道确认；
  审核员与管理员不受限（复核需要）。
- 发布入口：`solutions/eligibility` 返回 `blocked_reason: "running_contest"`，
  前端据此禁用按钮并说明原因，而非让用户点击后吃 403。
- 赛后复盘：竞赛页在 `ended` 出现「赛后复盘」标签，复用既有
  `verifyContestAccess` 的赛后放行，**不新增权限判定**。

## Alternatives considered

- **题解进题包（Problem Bundle）随包分发**：出题人写一次即可跨部署复用，
  但需同步改题包规范 / parser / CI / 文档四处，且用户题解与官方题解的所有权
  冲突难处理。已否决，题解走社区内容形态。
- **赛期门控用"先查题目 id 再拼 IN 列表"**：实现更直白，但必须设上限，
  上限一旦被超出就会**静默漏掉**应门控的题目 —— 对安全门控不可接受的失效模式。
  改为相关子查询，规模无关。
- **赛期隐藏全部 `solution_published` 动态**：实现最简，
  但会连普通练习题题解的活动一起隐藏，误伤面大。改为按 post→problem 反查。
- **用定时任务翻转竞赛状态、以状态位驱动门控**：需引入调度器与可变的
  状态列，多副本下还要处理竞争；实时窗口比较天然规避这一整类问题。
- **PGlite 模板用异步 hash 校验**：加载路径被大量同步调用点依赖，
  改动面过大；改为同步 DDL 指纹，等价且更小。

## Consequences

- **有意接受的代价**：某道题若既是"正在进行的竞赛题"又是日常练习题，
  其题解会在赛期对**所有人**隐藏。这是堵住剧透面所付的价。
  运营侧缓解：日常练习题避免与竞赛题复用同一题目记录。
- 官方题解依赖 `is_official` 列；存量部署需执行迁移 `0082_orange_omega_red.sql`
  （仅加列 + 加索引，已带 DEFAULT，实测在模拟存量库上干净通过）。
- 题目统计的 5 分钟缓存为单副本专用；多副本下最多 5 分钟内读到旧统计。
- 2000 条样本上限意味着超大数据集下统计为近似值，但通过 `truncated: true`
  显式暴露，不会被误读为完整统计。
- 赛期门控是**时间窗口实时判定**：系统时钟异常会直接影响门控正确性
  （与竞赛提交限额、封榜等既有机制同源风险，未新增风险面）。
- 本次实现过程中发现并另行修复了一个**发布阻断级**的既有缺陷：
  drizzle 快照链自 PR #473 起丢失 `public.search_entries`，
  导致 `db:generate` 会重新生成 `CREATE TABLE search_entries`，
  在存量库上必然失败。详见 `bug-fix/2026-09-14-drizzle-snapshot-chain-table-loss.md`。
