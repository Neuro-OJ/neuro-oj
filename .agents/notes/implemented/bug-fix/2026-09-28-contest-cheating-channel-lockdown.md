# Agent Note: 竞赛防作弊通道封堵（答疑广播 / 题解讨论门控 / 客观题回显 / 榜单与队列隐私）

Status: implemented

## Problem

2026-09-28 的全量源码审计（`contest_and_sandbox_security_audit.md`）在**高阶业务逻辑与跨模块访问边界**上发现多条可被赛中利用的通道，共同后果是：做题人可以在赛中互相通信、试探答案、或读到本应保密的赛题与成绩。

1. **答疑默认全场广播（VULN-01，Critical）**：`createClarification` 硬编码 `is_public: true`，任何选手的提问未经主办方审核即对全场实时可见（公开赛甚至匿名可读）。5000 字符的提问框因此成了赛中解法广播信道。
2. **题解与讨论门控形同虚设（VULN-02，Critical）**：`/solutions/eligibility` 的 `blocked_reason` 只是**前端提示**，落库的 `createPost` 完全没有公开赛归属校验——直接发包即可在赛中发布题解；`notGatedSolution()` 只覆盖 `type='solution'`（讨论区全量放行）且只查 `running` 窗口（公开赛**赛前筹备期**是最严重的泄密阶段，却被放行）。
3. **客观题即时回显对错（VULN-03，Critical）**：`stripExpected` 剥离了标准答案却**保留每题 `correct` 布尔值**并即时返回精确分数，作弊者可用小号把小量提交当答案预言机逐题排除选项。
4. **题库/聚合页面泄露赛题（VULN-07，High）**：保密只作用于"详情返回 404"，**列表照常返回题目行与完整 `description`**——存在性、标题、难度、标签、题面全部泄露。
5. **封榜期隐私倒挂（VULN-09，High）**：封榜分支在鉴权与"仅本人"过滤**之前**直接返回全量榜，使"平时看不到别人成绩"的选手一进封榜期就能（含匿名访客）看到全场明细。
6. **提交监听链（VULN-10，High）**：竞赛 SSE 广播只删 `user_id` 却保留 `submission_id`，而提交 SSE 订阅端点对非所有者不抛错（`getSubmission` 只把 `code/output` 置空），两者组合成"监听他人评测完成瞬间"的链路。
7. **队列泄密与权限倒挂（VULN-11/13，Medium/Low）**：`getQueueOverview` 无条件返回全站 `self_tests` 前 10 条（含题目、用户名与自测得分）；`getSubmissionQueueStatus` 的判据是 `viewerUserId !== undefined && role !== admin`，导致**匿名**反而跳过归属校验拿到排队位置，而登录的非所有者被拒。
8. **口径漂移的根因**：`problem-secrecy` / `problem-exposure` / `contest-window` / 社区自建 SQL 各持一份时间窗口判定，写法与窗口语义互不一致（有的 `running`、有的 `unended`、有的漏类型），任何一处漂移都会让上述门控静默失效。

## Decision

**先建单一真相源，再让所有门控复用它**（对应审计 §4.1）：

- contest 域（`services/problem-secrecy.ts`）新增权威取数：`unendedPublicContestForProblem(problemIdExpr)`（Drizzle SQL 谓词）、`isProblemInUnendedPublicContest(problemId)`（单条内存判定）、`filterUnendedContestIds(contestIds)`（竞赛维度「未结束」集合）。三者共用 `contest-window.ts` 的 `unendedWindowCondition`，口径统一为 `kind='public' AND now < end_time`（含 pending + running），形态非法时 **fail-closed**（视为未结束、继续保密）。`contest-window.ts` 同时导出审计规范名 `runningContestForProblem` 作为既有 `runningContestExistsForProblem` 的别名。
- `filterUnendedContestIds` 把 SQL 条件作为**投影列**而不是 `WHERE` 过滤：这样才能区分"已结束"与"竞赛不存在"，后者必须 fail-closed 视为未结束。
- **答疑（VULN-01）**：提问写入 `is_public: false`；只有主办方回复时显式 `is_public: true`（公告广播）才把**根提问连同答复**转为全员可见。可见性规则不变，但语义从"默认公开"反转为"默认私密"。
- **题解与讨论（VULN-02）**：`createPost` 增加服务层写入门控（题解与讨论只要关联题目归属未结束公开赛即拒绝，`moderator` 免门控）；`getPost` 详情与 `notGatedContestContent()`（原 `notGatedSolution`）列表谓词同时覆盖 `solution`/`discussion` 与赛前窗口；`/solutions/eligibility` 与读路径同口径。
- **客观题（VULN-03）**：竞赛模式提交返回**回执**（`{submission_id, paper_id, status, contest_mode, score: null, correct_count: null, details: {}}`）；详情与历史接口在竞赛未结束前把 `score` 置 `null` 并用 `stripContestJudgement` 只保留 `given`。`QuestionJudgement.correct` 因此在类型上变为可选（缺失 ≠ 错误）。
- **全域隐藏（VULN-07）**：题库列表、题单、个人主页（已通过题目 / 最近提交）与全局搜索统一注入 `NOT unendedPublicContestForProblem(...)`，对非特权用户**整行不返回**；特权用户（管理员 / 题目所有者）保留该行并额外收到 `is_contest_hidden: true`（题库与题单响应），个人主页 `solved_problems[]` 同样下发该标记。
- **榜单（VULN-09）**：把身份（登录 / 参赛）与"仅本人一行"守卫**提到视图状态判定之前**；封榜视图对非管理员同样只返回本人一行，匿名得到空列表。
- **SSE（VULN-10）**：竞赛提交事件对非管理员同时剔除 `user_id` 与 `submission_id`（实时与重放两条路径同口径）；`/submissions/:id/events` 在订阅前增加归属校验（非本人且无 `submission:read_all` → 403）。
- **队列（VULN-11/13）**：`getQueueOverview(isAdmin, viewerUserId)` 对非管理员的自测 pending/judging/recent/统计一律加 `user_id` 约束（未登录 → `false`，fail-closed）；`getSubmissionQueueStatus` 改为"非 admin 时必须 `viewerUserId` 存在且等于提交所有者"。
- **反作弊口径**：竞赛提交路由与通用路由统一走 `createSubmission`，IP 反作弊机制整体下线（见另一篇 simplification 记录）。

## Alternatives considered

- **各处继续各自手写窗口 SQL，只补漏掉的分支**：最省改动，但审计已证明这正是缺陷来源（同一语义四处副本、三条窗口口径）。拒绝。
- **抽象通用"（表名 + 主键）→ 是否被公开赛关联"泛型组件**：题目、帖子、题单、提交的关联拓扑异构（一跳外键 / 二跳间接 / 多对多），泛化必然退化为内部 `switch(table)` 的伪抽象，并破坏类型安全与索引优化。拒绝（与审计 §4.1 裁定一致）。
- **客观题赛期仅隐藏 `details`、保留分数**：分数变化本身即可用于二分探测（提交一次看分数是否上涨），无法防试探。拒绝。
- **封榜期对非管理员直接 403**：审计要求是"保持仅返回本人数据的隐私策略"，且封榜是 `running` 的子区间，直接 403 会破坏"参赛者看自己成绩"的正常需求。改为只返回本人一行。
- **匿名访问封榜榜返回 401**：对**已结束**竞赛（待结算期）会在无赛期中引入新的登录门槛；改为返回空列表（不泄露、也不新增错误路径）。
- **`notGatedSolution()` 保留旧名、只扩类型**：函数名会把"只门控题解"的旧语义固化进新代码。改为 `notGatedContestContent()`，调用点同步；search 域保留 `runningContestSolutionWhere` 旧名作为别名以减少无关改动。

## Consequences

- 竞赛防作弊从"前端提示 + 单点 404"变为**服务层强制 + SQL 层全域过滤**：绕过前端直接发包不再有效。
- **行为变化（需运维/出题人知晓）**：
  - 赛期答疑默认私密，主办方必须用"公开回复"才能广播；
  - 题目一旦被加入任何**未结束**的公开赛，其题解/讨论会立即对全场隐藏（含作者本人），且该题在题库/题单/个人主页/搜索中对非特权用户消失，直到竞赛结束——这是有意的（赛前筹备期同样需要保密）；
  - 客观题竞赛提交在赛后结算前不再显示分数与逐题对错（含管理员；管理员可查库）；
  - 封榜期非管理员只看到本人一行，匿名看到空榜。
- 新增字段 `is_contest_hidden`（题库列表 / 题单 / 管理端题目列表 / 个人主页已通过题目）与 `ContestProblemResponse.visibility`（供邀请赛选题风险提示），均为可选/附加字段，旧客户端忽略即可。
- 单一真相源的维护成本集中到 `problem-secrecy.ts`：未来时间戳类型校正或保密规则变更只需改一处；`filterUnendedContestIds` 的投影列写法是该模块唯一需要留意的实现细节（换成 `WHERE` 会让"不存在"与"已结束"不可区分，已有回归测试钉住）。
- 测试：contest 域新增 SSOT 口径一致性回归（内存判定 vs SQL 谓词 vs 集合）、VULN-01 答疑公私可见性回归；社区域更新门控与动态测试；审计中判定的 VULN-04/VULN-05（邀请赛挂公开题不受遮蔽）维持现状，仅在前端选题弹窗增加风险提示。
