# 作弊审查工作区笔记（2026-09-05，未定稿）

## 方法
只读静态审查。5 个狩猎子代理(contest/submission/objective+query/judge/gateway+auth) + 主代理手工复核。
复核标准：普通单人登录选手，能获得榜单优势。

## 高置信发现（主代理第一手确认，待子代理结果汇入后统一评级）

### C1 [偷答案|objective] 客观题竞赛套卷标准答案泄露 —— 严重
- 位置：noj-core/src/domains/objective/services/objective-submissions.ts:120-199（submitObjectivePaper）
- 利用链：
  1. GET /contests/:id/problems 拿到套卷 problem_id（contestProblems 返回真实 UUID/display_id）
  2. POST /api/v1/problems/<paper_id>/submit body={"answers":{}}  （不带 contest_id → practice 模式）
  3. validateAnswersPayload 允许空对象（types/objective.ts:195-211）
  4. judgePaper 对每题返回 {correct,expected,given}（objective-judge.ts:82-86），expected=标准答案明文
  5. practice 分支 withExplanation 不裁剪 expected，还附 explanation（objective-submissions.ts:100-113,194-196）
  6. 响应 = 整卷标准答案 + 解析
- 前提：知道套卷 problem_id（contest 参赛者可获）；套卷是 problems 表同一记录（无竞赛隔离副本）
- 影响：客观题竞赛满分作弊；无限次（限流仅 30s 窗口计数）
- 置信：高（代码直接证据）
- 修复方向：practice 模式也要 owner/admin 门控，或竞赛期间套卷不可 practice 提交；或 practice 响应剥 expected

### C2 [排名操纵|SSE] running 榜"只见自己"被 SSE+详情击穿 —— 高
- 位置：
  - noj-core/src/domains/contest/routes/sse.ts:129-149（剥 user_id 但保留 submission_id, problem_id）
  - noj-core/src/domains/submission/services/submissions/submissions-crud.ts:551-644（getSubmission：基础字段+score 对所有人可见，hideResult=false）
- 利用链：订阅 /contests/:id/events → 收 contest:submission:created{contest_id, submission_id, problem_id} → GET /api/v1/submissions/:id（optionalAuth）→ 得 user_id, score, status → 重建全榜 + 每人对每题得分；SSE 剥的 user_id 从详情补回
- 前提：参赛者；详情接口匿名可查已知 id（id 不可枚举但 SSE 提供 id）
- 影响：实时看到对手每题得分进度 = 击穿 Kaggle 隐藏榜意图
- 置信：高
- 修复：SSE 不向非 admin 推 submission 粒度；详情对 running 竞赛隐藏 score 或要求 owner/admin；或详情也做 contest running 的 participant 限制

### C3 [绕过限制|TOCTOU] contest submission_limits 并发绕过 —— 中
- 位置：noj-core/src/domains/submission/services/submissions/submissions-crud.ts:320-338（assertContestSubmissionLimit 后 insert，无锁无事务）；artifact-submissions.ts:122-129 同模式
- 利用链：并发 N 请求同时过 count 检查再 insert → 突破 limit
- 前提：submission_limits 配置存在；代码题与 artifact 题都可
- 影响：Kaggle 提交次数限制（防试错刷分）被突破
- 置信：中（需并发窗口；insert 很快，窗口窄；但攻击者可放大：同时建 N 连接）
- 修复：SELECT ... FOR UPDATE 锁 contest_problems 行 或 count 检查与 insert 同事务 + 唯一约束/序列化

### C4 [待定|提前信息] self-test 对竞赛题无 contest 门禁
- 位置：noj-core/src/domains/submission/services/self-tests.ts:53+（createSelfTest 只查 problem 是否存在，无 contest 校验）；routes/self-tests.ts:26-63 只 authMiddleware
- 场景：竞赛期间参赛者拿竞赛题 problem_id 跑自测 → 走完整评测流程（同 judge 队列）
- 价值取决于 judge 返回输出内容是否含隐藏用例反馈；若自测输出与正式一致则等于"无限次提交探测判据且不进榜/不计数"；若不一致则低
- 置信：中（机制确定存在，危害待 judge 侧确认）
- 待子代理（judge）确认

## 待办
- [ ] 等 5 子代理返回，逐条对抗复核
- [ ] judge 侧确认 self-test 输出粒度（C4 定性）
- [ ] 深挖：LLM 题 eval_token / 额度（gateway 子代理）
- [ ] 按类别汇总 + 严重度评级 + 写报告
### C5 [提前开始|题面泄露] 竞赛题全局可见无"未开赛隐藏" —— 高（新增定稿）
- 位置：noj-core/src/shared/db/schema/catalog.ts:21-66（problems 表无可见性/私有列，仅 type U/P + owner_id）
       noj-core/src/domains/catalog/routes/problems.ts:177-188（GET /:id optionalAuth，只裁算法标签，无竞赛状态判断）
       noj-core/src/domains/contest/services/contests.ts:177-195（assertProblemsExist 只查存在性，不查可见性）
- 利用链：竞赛题目复用全局 problems 记录，无任何题目级保密机制 → U 型题号自增（U1..Un 可猜）
  → GET /problems/U<n> 返回完整题面（含样例）→ 开赛前提前准备/预写解法
- 前提：竞赛使用新建 U 型题；攻击者猜 display_id（U 型题数量可经其他渠道估计）
- 影响：赛前拿到题面 = 提前开始（对算法题预写 AC 解法；配合 C1 对客观题拿答案）
- 置信：高（schema + 路由直接证据）
- 修复方向：problems 增加 visible_from / is_private 状态并让详情/搜索/列表强制过滤；
  或 contest_problems 引用时创建"竞赛专用副本"（题面运行时才下发）
### C4 定稿 [绕过限制|探测判据] 竞赛期间自测通道 = 绕过 submission_limits 的探测侧信道 —— 中
- 位置：noj-core/src/domains/submission/routes/self-tests.ts:26-63（仅 auth + enforceSelfTestRateLimit，无 contest 门禁）
       noj-core/src/domains/submission/services/self-tests.ts:53-194（createSelfTest 只查题目存在；记录入 self_tests 表，不进 submissions → 不计 contest submission_limits）
       noj-judge/src/dual/mod.rs:1103-1126（judge 对 st_ 前缀无特判，自测与正式提交完全同构：output=stdout+stderr 合并、details=JSON 透传）
- 利用链：参赛者拿竞赛题 problem_id（C5 可得/参赛可得）→ POST /problems/:id/self-test（contest 期间无拦截）→ judge 完整评测（含 hidden 用例）→ GET /self-tests/:id 读回 output/details（owner 私有）
  → 无限次探测隐藏判据（失败用例 input/expected 若在 details 中即泄露），不受竞赛提交次数限制，不留榜单记录
- 缓解：限流 60s/4 次（SELF_TEST_USER_LIMIT）压吞吐；details 是否含判据取决于 evaluate.py 实现（judge 透传）
- 影响：试错刷分/摸清边界（Kaggle artifact 题尤其——每次自测跑完整评分）而不消耗正式提交次数
- 置信：高（机制）；危害依赖 evaluate.py 输出粒度 → 评级中
- 修复：contest 题在竞赛期间禁 self-test（contest 上下文传入 createSelfTest）；或自测输出脱敏；或自测计入提交限制
