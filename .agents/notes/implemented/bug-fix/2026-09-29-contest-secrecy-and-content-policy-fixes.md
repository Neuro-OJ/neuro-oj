# Agent Note: 赛时社区全局静默、全站榜单隔离与保密信道加固（Batch 3）

Status: implemented

## Problem

在开赛前无人值守审查与决策复核中，识别出赛时内容政策、排行榜侧信道与保密信道层面的多项关键缺陷：
1. `N-01` / `FC-01` / `AR-09`（决策 1）：比赛进行期间社区未实现全局静默，普通用户可通过发布新讨论帖、短动态甚至借讨论帖关联赛题进行场外交流；讨论帖关联题目未做未完赛公开赛保密校验；且落库时缺少对 discussion 类型 `problem_id` 的持久化支持；
2. `F-02` / `DL-02` / `DL-03`（决策 3）：全站大排行榜（`/rankings`）和个人主页解题数在比赛期间实时累加赛中通过数，且 `total_submissions` 和 `acceptance_rate` 产生赛中波动，伴随全站 `stats:updated` SSE 实时广播，构成致命的外部侧信道泄密；
3. `AR-10`（决策 6）：Kaggle 赛制榜单在计算同分平局破局时，包含 0 分与低分提交的刷新时间，导致选手取得最高分后再提交 0 分或编译错误代码会推后其上榜时间；
4. `DL-01` / `DL-05`：客观题练习模式提交在题目已被收编进未结束公开赛时，直接返回了解析与答案；他人提交详情返回 403 构成存在性探测旁路（Oracle）；
5. `FC-03` / `FC-04` / `FC-05`：竞赛 SSE 的封榜视图判定在连接建立时静态固化，若选手在非封榜期连入，跨入封榜窗口后连接依然持续推送实时榜单事件；答疑提问接口缺少频控；答疑列表全量拉取后在内存分页；举报工单接口直接在响应体回显帖子快照造成泄密。

## Decision

针对上述问题，严格落实产品表决决策，实施以下统一工程修复：
1. **赛时社区全局静默与发帖门控（决策 1 · 方案 A）**：
   - 在 `problem-secrecy.ts` 抽象并导出 `hasUnendedPublicContest()` 与 `isProblemInUnendedPublicContest()`；
   - 在 `community-post-crud.ts` 中前置门控：全站存在未结束公开赛时，非管理员发布讨论帖与动态统一抛出 `CONTEST_SILENCE`（`ForbiddenError`）；讨论帖关联 `problem_id` 校验未结束公开赛题目保密，并持久化 `problem_id`；
2. **全站榜单与个人成就赛中数据隔离（决策 3 · 方案 A）**：
   - 在 `rankings.ts`、`stats-cache.ts` 与 `users-profile-queries.ts` 中，统一在 SQL 查询的 `WHERE` 条件中引入 `endedWindowCondition`，彻底排除属于未结束比赛的全部提交；`total_submissions` 与通过率分母同步排除，杜绝赛期指标波动与侧信道探测；
   - 在 `submissions-result.ts` 中对未完赛竞赛提交跳过 `applyNewResult`，阻断满分计数递增与全站 `stats:updated` SSE 广播；
3. **Kaggle 平局决胜锁定有效最高分（决策 6 · 方案 A）**：
   - 修改 `contest-ranking.ts` 中的 `user_totals` SQL 排序逻辑，将最后达成时间锁定为 `MAX(ps.last_best_at) FILTER (WHERE ps.best_score > 0)`，后续 0 分或低分提交绝不推后选手排名；
4. **客观题赛期保密与 404 存在性屏蔽**：
   - 在 `objective-submissions.ts` 中，练习模式若题目收编于未结束公开赛强制调用 `stripExpected` 隐藏解析与答案；非本人/非管理员查询详情由 403 改为抛出 `NotFoundError`（404），彻底消除存在性探测预言机；
   - 在 `catalog` 域的 `trainings.ts` 与 `tags.ts` 中，题目数统计与列表下推过滤公开且未在保密公开赛中的题目；
5. **信道与接口加固**：
   - 改造 `sse.ts`，在循环推送前根据当前系统时间动态执行 `isNonLiveView()` 封榜窗口判定；JSON 解析异常一律丢弃（Fail-Closed）；
   - 在 `contests.ts` 答疑创建接口增加 5 次/分钟频控（`checkRateLimit`）；答疑列表可见性与分页逻辑直接下推到 SQL 并在数据库计算总数；
   - 移除举报响应体中的 `content_snapshot` 回显，并将举报门控放宽至含题目的任何讨论帖。

## Alternatives considered

- 赛期全站总榜完全停止访问（决策 3 方案 B）：对不参赛的普通刷题用户体验损害较大，采用 SQL 过滤排除赛中提交（方案 A）既保证了非赛题日常提交的正常流转，又彻底阻断了赛中泄密。
- 在应用层拉取数据后内存过滤未完赛竞赛：对于大规模榜单和个人主页聚合查询，全量拉入内存计算开销过大且无法保证分页与总数一致，因此统一将 `endedWindowCondition` 下推至 SQL。

## Consequences

- 赛期普通用户无法通过社区讨论赛题，全站大榜与个人主页不会实时泄露参赛者的提交进度；
- Kaggle 赛制参赛者后续提交 0 分代码不再惩罚历史排名，平局排序更公正；
- 客观题赛期答案不再通过练习或枚举接口被探测，答疑接口具备防刷与高效分页能力；
- 全部改动通过 `deno task check` 与 domain 单元测试（`community`, `query`, `catalog`, `objective`, `contest`, `submission`）。
