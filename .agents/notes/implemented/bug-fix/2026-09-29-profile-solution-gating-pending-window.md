# Agent Note: 个人主页题解门控补齐赛前筹备期（口径收敛到 unended）

Status: implemented

## Problem

2026-09-29 的公开赛开赛前无人值守审计（面 1.4「noj-core 数据泄露读路径矩阵」，见
`dev-docs/unattended/2026-09-28/findings/04-core-data-leakage.md`）以"**穷举读路径**"的方式复核
9-28 的整改，发现一条被漏掉的路径：

`noj-core/src/domains/identity/services/users/users-profile-queries.ts` 的
`queryProfileCommunityStats`（`:197-201`）与 `queryProfileSolutions`（`:238-246`）用的是
**旧口径** `runningContestExistsForProblem`（仅 `start_time ≤ now < end_time`），而 9-28 的整改
已把社区列表、社区详情、搜索、`solutions/eligibility` 全部换成 **`unended`**（`kind='public'
AND now < end_time`，**含 pending 赛前筹备期**）。

后果：题目一旦被加入一场**尚未开始**的公开赛，它的题解在个人主页上仍然可见——
`GET /api/v1/users/:id/profile` **匿名可读**，攻击者只需枚举 uid/username 即可在赛前读到
该题的题解**标题**，以及"该题已有题解"这一存在性事实。赛前筹备期恰恰是泄密后果最严重的
阶段（题目尚未公开、选手还没有机会通过正常途径看到它）。

这是"枚举读路径 + 注入过滤谓词"这一修法的**结构性失效点**：同一份"未结束公开赛"的事实在
仓库里存在**两个可互换的 SQL 出口**，其中一个把 pending 当可见；漏掉任一读路径即等于没修。
同文件 `:186-193` 的注释本身已写明"计数与列表口径必须一致——否则数量本身就是侧信道"，
但该原则当时未施加到这两个函数。

该路径**此前没有任何测试覆盖**（`rg queryProfileSolutions|queryProfileCommunityStats` 在
测试目录 0 命中），因此 2026-09-14 那轮"个人主页题解标题泄露"的修复只把窗口钉在 `running`，
pending 窗口从未被断言过。

## Decision

1. **两处调用点收敛到单一真相源**：改用 contest 域 SSOT 的
   `unendedPublicContestForProblem(communityPosts.problem_id)`（该谓词此前**已在本文件导入**但
   未被使用），并移除 `runningContestExistsForProblem` 的导入。
2. **补回归测试**（新增 `noj-core/src/domains/identity/tests/services/users-profile-secrecy.test.ts`）：
   一条流程锁死四种窗口 ——
   ① 未被任何竞赛收编 → 题解与计数均可见（基线，证明断言不是恒真）；
   ② 进行中公开赛收编 → 均隐藏（2026-09-14 既有行为的回归守卫）；
   ③ 竞赛结束 → 自动放行（赛后复盘）；
   ④ **赛前筹备期（pending）→ 均隐藏**（本次修复点）。
   计数与列表**同时**断言，锁住"口径必须一致"（否则数量本身就是侧信道）。
3. 两个函数各补一条注释，写明"口径必须是 unended（含 pending），不能用 running"，避免下一位
   维护者按直觉改回 running。

## Alternatives considered

- **只改 `queryProfileSolutions`（列表），保留计数用 running**：拒绝——那正是同文件注释警告的
  "计数 3、列表 2 条"侧信道：差额本身即泄露"存在一道被保密题目的题解"。
- **在 identity 域自写 `EXISTS` 子查询**：拒绝——`noj-core/AGENTS.md` 明文规定"所有新门控**禁止**
  再手写时间窗口比较（口径漂移正是上述漏洞的根因）"，且 SSOT 谓词已在本文件导入。
- **直接删除 `runningContestExistsForProblem`**：本轮未做。它是 contest 域的既有导出，可能仍有
  非保密用途（本面只核到 identity 这一处调用点）。正确的收敛动作（在 SSOT 内统一、或由门禁
  禁止新增手写窗口比较）已列入 final-report 的待办。
- **改用 `isProblemInUnendedPublicContest`（逐条内存判定）**：拒绝——本查询是 SQL 列表/计数场景，
  SSOT 文档明确要求此类场景用 `unendedPublicContestForProblem`（相关子查询，不受题量规模影响、
  也不会因 `IN` 列表上限静默漏判）。

## Consequences

- 个人主页的题解列表与题解计数在**赛前筹备期**即对非特权用户与匿名隐藏，与社区/搜索口径一致；
  竞赛 `end_time` 一过自动放行。
- 管理员/审核员视图（`moderator=true`）免门控的行为不变。
- 该路径首次获得测试覆盖；此后若有人把口径改回 `running`，新增用例的第 ④ 段会立即失败。
- **同类风险未穷尽**：同一审计还指出 F-03（自测路径返回 403 vs 404 → 存在性预言机）、
  F-04（另三处计数/列表不齐）、F-06/F-07（竞赛与全站聚合计数）、F-08（`problem-access.ts:86`
  注释与实现矛盾，构成回归风险）以及 **F-02（全局 `/api/v1/rankings` 无竞赛窗口判定且匿名可读，
  构成赛中他人进度侧信道，High）**。这些**本轮未修、也未经独立复核**，仅为单方审计证据，
  不得视为已确认缺陷——详见 final-report 的待人工清单。
