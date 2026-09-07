# Neuro OJ 竞赛选手作弊面审查报告（2026-09-05）

> **状态：已完成**（2026-09-05 只读审查；5 子代理 + 主代理对抗复核）
> **基线**：main @ 6533bff3d（题目级 LLM 预算 Agent Note）
> **范围**：noj-core（contest/submission/objective/query/gateway 调用链）、noj-judge、noj-llm-gateway；noj-ui 仅作数据下发信息源
> **威胁模型**：普通单人注册用户选手（无团伙/无管理员/无服务器权限），动机 = 榜单名次/奖品
> **视角**：区别于 2026-08-15 通用安全审计（225 真阳性），本报告只关心"选手能获得何种榜单优势"的利用链

---

## 0. 严重度汇总

| 编号 | 严重度 | 标题（一句话） | 置信度 | 来源 |
|---|---|---|---|---|
| F-01 | **严重** | 客观题套卷练习提交泄露整卷标准答案（赛前即可，任意登录用户） | 高 | 主代理 + objective 子代理 |
| F-02 | **高** | SSE + 公开提交详情击穿"running 榜仅本人"隔离 → 实时重建全榜 | 高 | 主代理 + contest 子代理 |
| F-03 | **高**(依赖运营假设) | 平台无题目保密状态 → 未开赛题面可预读（U 型号可枚举） | 高 | 主代理 + objective 子代理 |
| F-04 | 中 | contest submission_limits 存在 TOCTOU → 并发突破 | 中 | 主代理 + submission 子代理 |
| F-05 | **高** | 竞赛隔离只在路由层：普通提交/artifact/自测可场外无限完整评测（真实 hidden 判据） | 高 | 主代理 + submission 子代理升级 |
| F-06 | **高** | LLM 题共享日预算可被"关门" → 冻结他人 LLM 题得分 | 高 | gateway G1 |
| F-07 | **高** | judge 并发 2 槽 + 全局单队列 → 拖死他人评测时序 | 高(机制) | judge J1 |
| F-08 | 中-高 | artifact zip 无任务级总超时 + 多份内存驻留 → judge OOM | 高(机制) | judge J2 |
| F-09 | 中 | solution 可无限调用 BYOK 能力烧额度 | 中 | judge J3 |
| F-10 | 中 | gateway "unknown" 共享速率桶 → 低成本随机 429 干扰 | 中 | gateway G3 |
| F-11 | 低-中 | 评测输出全量回传 owner → 评分标准若入 LLM 上下文即泄（出题依赖） | 低-中 | gateway G4 |
| F-12 | 中-高 | 注册无验证 + 仅 IP 限流 → 批量开号放大共享配额攻击 | 高(机制) | gateway G2 |
| F-13 | 低-中 | 密码房注册接口无限流/锁定 → 口令在线爆破 | 高(机制) | contest 子代理 |
| F-14 | 中 | 客观题防泄题裁剪不一致：提交历史列表泄露竞赛卷完整 expected | 高 | objective 子代理 O3 |
| F-15 | 中-高 | 全站评测队列概览无竞赛过滤 → 运行中竞赛进度具名实时可见 | 高 | submission S1 |

---

## 1. 修复优先级（综合 5 子代理排序 + 主代理定级）

- **P0（赛前满分 / 整卷答案直漏，最优先）**：F-01、F-05（含 F-04 同根，门禁下沉 service 层）、F-03（补题目保密机制）
- **P1（赛中情报 / 干扰 / 关门）**：F-02、F-15（队列脱敏）、F-06（每用户×题目累计预算）、F-07（judge 公平调度）、F-14（落库即剥 expected）
- **P2（资源 / 条件 / 部署）**：F-08、F-10、F-12、F-09、F-13、F-11、F-04（并发收紧）

---

## 2. 与 2026-08-15 旧审计的关系

**复用确认已修复（选手侧已闭合，未重复报）**：NOJ-000（JWT 算法）、NOJ-091（IP 伪造 fail-closed）、NOJ-049（queue status IDOR）、NOJ-062（evaluator 命令/网络权限）、NOJ-115/116（支持包存储越权，下载侧已封）、NOJ-161/075（rejudge_seq）、NOJ-171/187/188/190/193/194（judge 沙箱加固）、NOJ-179（BRPOPLPUSH + ack）。

**同源未修 / 再现（本报告交叉引用，非重复）**：
- F-01 ↔ NOJ-012（8-15 已记录"客观题练习模式泄答案"，**至今未修**）
- F-03 ↔ NOJ-016 同根（榜单 SQL 无 start_time 下界；U 型题无保密列是更广的机制缺失）
- O1/F-01 ↔ NOJ-102 同构（U 型操作无权限断言——答题/读题路径同样无 owner 门控）

**本次新增（选手利用视角 + 新端点，旧审计未覆盖）**：F-02/05/06/07/08/09/10/12/13/14/15 —— 其中 F-02/F-15（实时情报）、F-05（服务层门禁缺失）、F-06（LLM 预算关门）为最高价值新增。

---

## 3. 方法
1. 主代理手工精读核心链路（contest 可见性/注册/限次、submission 详情可见性、SSE、ranking SQL、objective 判分/提交、self-test、clarification、queue）
2. 5 个只读子代理并行狩猎（contest / submission / objective+query / judge 沙箱 / gateway+鉴权）
3. **逐条对抗复核**：主代理亲自读码验证每条利用链成立（不盲信子代理）——抓出 1 个假阳性（contest 子代理 D1[1]"伪造 contest_id 入榜"，见第三节），修正 2 处评级（F-05 升级、F-01 补强赛前可利用性），统一落盘

## 4. 严重度口径
- 按"单人选手可利用程度 × 榜单优势 × 操作难度/隐蔽性"定级（区别于安全 CVSS：只关心选手侧）
- 级别：严重（直接满分/直接窃取标准答案）/ 高（实质情报优势或绕过核心限制）/ 中（有限情报或需并发/时序条件）/ 低（噪音或低价值）

---

## 一、发现明细（按严重度排序）

### F-01 【严重】客观题套卷"练习提交"泄露整卷标准答案 —— 竞赛客观题可满分作弊
- **位置**：noj-core/src/domains/objective/services/objective-submissions.ts:100-113, 120-199（withExplanation 与 submitObjectivePaper）
  noj-core/src/domains/objective/services/objective-judge.ts:82-87（judgeQuestion 返回 expected）
  noj-core/src/domains/objective/types/objective.ts:195-211（validateAnswersPayload 允许空 answers）
  noj-core/src/domains/catalog/routes/problems.ts:490-501（POST /:id/submit 仅 auth，无竞赛门禁）
- **利用链（选手视角）**：
  1. 注册任意竞赛成为参赛者，GET /contests/:id/problems 拿到套卷的 problem_id；
  2. 调 POST /api/v1/problems/<paper_id>/submit，body={ "answers": {} }（不带 contest_id → 练习模式）；
  3. 服务端先判题后裁权限：judgePaper 对卷内每题无条件生成 {correct, expected(标准答案), given}（judge.ts:98-102），练习模式走 withExplanation 不剥 expected、还附加解析文本；
  4. 响应即整卷标准答案 + 解析 → 再以 contest_id 正式提交一次拿满分。
- **前提**：套卷是 problems 表普通记录（contest_problems 仅存引用，无竞赛副本/隔离）。
- **严重度补强（2026-09-05 复核）**：本链**不限于竞赛期间、也不要求参赛**——提交端点无任何"套卷被 running 竞赛引用"门禁，且 GET /problems/:id/questions（problems.ts:427-442，optionalAuth）对非 owner 返回全部题干。因此**任意客观题套卷从创建起，任何登录用户即可**：① 读题干 → ② 空 answers 练习提交拖走整卷标准答案。客观题"练习模式可无限次提交 + 返回判据"与"套卷答案须保密"两个需求在实现上根本冲突；对竞赛而言等于赛前答案全泄露（无需 F-03 的题号猜测，套卷作为公开 U 型题题干本就可读）。
- **影响**：客观题竞赛直接满分；一次请求即得答案，限流（60 次/分）不构成障碍；练习提交不写 contest 记录、无痕。
- **置信度**：高（全链路代码直接证据，无任何中间环节缺失）。
- **修复方向**：练习模式提交需套卷 owner/管理员门控；或竞赛期间（该套卷被 running 竞赛引用时）拒绝练习提交；或练习响应同样剥除 expected（只回 correct/given）。

### F-02 【高】running 榜"仅返回本人"被 SSE + 公开提交详情击穿 —— 实时重建全榜+每题得分
- **位置**：noj-core/src/domains/contest/routes/sse.ts:129-149（订阅转发：仅剥 user_id，保留 submission_id/problem_id）
  noj-core/src/domains/submission/services/submissions/submissions-crud.ts:581-614, 625-643（getSubmission 对非 owner 也返回 score/status/user_id；hideResult=false）
  noj-core/src/domains/submission/routes/submissions.ts:298（GET /:id 为 optionalAuth）
- **利用链（选手视角）**：
  1. 参赛者长连 GET /contests/:id/events，实时收到他人 contest:submission:created{contest_id, submission_id, problem_id}（user_id 被剥，但 submission_id 保留）；
  2. 逐个 GET /api/v1/submissions/<submission_id>（无需登录；提交 ID 不可枚举但 SSE 已提供）→ 返回 user_id、problem_id、status、result.score、created_at；
  3. 把 SSE 剥掉的 user_id 从详情补回 → 重建"谁在何时对哪题拿到多少分"的完整实时画像，与正式榜对照即知他人全部试错轨迹。
- **前提**：参赛者；详情接口按设计对所有人公开基础数据（含分数）。
- **影响**：击穿 Kaggle 实时榜"隐藏他人成绩"的设计意图（SSE 特意剥 user_id 但详情接口把它还回来）——知道对手哪题已 AC、各题当前得分，可针对性分配剩余提交次数。
- **置信度**：高。
- **修复方向**：① running 竞赛 SSE 不向非 admin 推送 submission 粒度事件（只推 ranking 变化）；② getSubmission 对"running 竞赛中的他人提交"隐藏 score/status 或整体 404；③ 提交详情接口要求 owner/admin 或参赛者，且不返回他人 user_id。

### F-03 【高（取决于运营假设）】平台无"题目保密"状态 —— 未开赛竞赛题面可提前读取
- **位置**：noj-core/src/shared/db/schema/catalog.ts:21-66（problems 表仅 type(U/P)+owner_id，无 visible/private/visible_from 列）
  noj-core/src/domains/catalog/routes/problems.ts:177-188（GET /:id 详情 optionalAuth，仅裁算法标签，无竞赛状态判断）
  noj-core/src/domains/contest/services/contests.ts:177-195（assertProblemsExist 仅查 ID 存在性，不查可见性/归属）
- **利用链（选手视角）**：竞赛新建题目即全局 problems 行；U 型题号 (type,number) 自增、display_id 形如 U<n> 可枚举 → 开赛前 GET /problems/U<n> 或 /problems/<UUID> 直接得完整题面（description+样例）→ 提前预写解法/准备答案。客观题套卷同表，题干同样提前可见。
- **前提**：运营方假设"新建题 + 非公开竞赛 = 赛前保密"。若竞赛用公开题库老题（题面本公开）则无此问题；新题保密场景必中招。
- **影响**：赛前拿到题面 = 变相提前开始；对算法题可预写 AC，对客观题叠加 F-01 即满分。
- **置信度**：高（机制层面确凿：无保密列 + 详情公开 + 列表不可枚举只防搜索不防已知链接）。
- **修复方向**：problems 增加 visibility/visible_at/owner 白名单并在详情/搜索/列表统一强制；竞赛专用"题目实例"（题面在 running 才下发）；或至少为竞赛创建题目副本。

### F-04 【中】竞赛提交次数上限（submission_limits）存在 TOCTOU —— 并发可突破
- **位置**：noj-core/src/domains/submission/services/submissions/submissions-crud.ts:331-338（assertContestSubmissionLimit 在 insert 前无锁无事务）
  noj-core/src/domains/submission/services/submissions/artifact-submissions.ts:122-129（同模式）
  noj-core/src/domains/contest/services/contests.ts:631-664（assertContestSubmissionLimit 为独立 count 查询）
- **利用链（选手视角）**：限制语义"该题最多 N 次提交（含 error）"靠 count(*)<N 实现；攻击者并发 N+1 个请求同时过 count 再 insert → 超限提交。代码题与 artifact 题均可。配合 F-05 价值有限，但正式提交超限直接影响 Kaggle 榜单（可多拿 N 次试错机会）。
- **前提**：题目配置了 submission_limits；需要并发窗口（insert 很快，但可多连接放大）。
- **影响**：试错刷分次数上限被突破（Kaggle 类竞赛核心限制）。
- **置信度**：中（竞态窗口真实存在，实际利用需毫秒级并发，但攻击者可多开连接/脚本化提升命中率）。
- **修复方向**：count+insert 同事务并对 contest_problems 行加 FOR UPDATE（或对该 user×contest×problem 唯一约束 + 乐观重试）。

### F-05 【高】竞赛隔离只在路由层——普通提交/artifact/自测接口均可场外无限完整评测（submission 子代理 S2/S4 复核升级）
- **位置**：
  - 门禁仅存在于 contest 路由（noj-core/src/domains/contest/routes/contests.ts:263-331：running/participant/submission_limits 全在此层）
  - service 层三入口均无竞赛上下文：submissions-crud.ts:320-356（createSubmission）、artifact-submissions.ts:105-145（createArtifactSubmission）、self-tests.ts:53-75（createSelfTest）——只查题目存在/语言/镜像白名单
  - 普通提交路由 submissions.ts:182-226 不透传 contest_id → 落库 contest_id=null
  - 榜 SQL 仅统计 contest_id 匹配行（contest-ranking.ts:58-71）→ 场外练习行不进榜、不耗 submission_limits
  - 限流仅：普通提交 120/min、self-test 60s/4 次
  noj-core/src/domains/submission/services/self-tests.ts:53-194（createSelfTest 只查题目存在；写 self_tests 表，不计 submissions → 不计 contest submission_limits、不进榜单）
  noj-judge/src/dual/mod.rs:1103-1126（judge 对 st_ 前缀无特判：自测与正式提交同构评测，output=stdout+stderr，details=JSON 透传）
- **利用链（选手视角）**：拿到竞赛题 problem_id → 竞赛期间 POST /problems/:id/self-test → judge 跑完整评测（含 hidden 用例）→ GET /self-tests/:id 读回 output/details（仅自己可见）→ 在不消耗正式提交次数、不留榜单记录的前提下探测隐藏判据/边界（失败用例的 input/expected 若由 evaluate.py 写入 details 即直接泄露）。
- **前提**：evaluate.py 输出 details 的粒度（judge 仅透传）；限流 60s/4 次（SELF_TEST_USER_LIMIT）压吞吐。
- **评级修正（2026-09-05 复核样例 evaluate.py，data/problems-src/1001/evaluate.py:115-135）**：样例实现对 hidden 用例不写入 input/expected_output/actual_output（仅 visible 明文），details 只含 hidden passed/total/status → 选手实际得到"隐藏点过/不过"oracle 而非判据明文。但脱敏属出题脚本自律，SDK 无平台级强制 → F-05 实际为 oracle 探测通道，评级中-低。
- **影响**：running 竞赛期间，持竞赛题 problem_id 的任意登录用户可经普通提交/artifact/自测接口对真实 hidden 判据做无限次完整评测（120/min 或 4/min）——样例 evaluate.py 对 hidden 用例逐条打印 [HIDDEN] <case_id>: PASS/FAIL 并回传逐例状态（data/problems-src/1001/evaluate.py:103-110,157-176）→ 本地收敛到满分解后一次正式提交进榜；submission_limits/参赛门/时间窗全部绕过。样例实现即 oracle，LLM 工程题 details 可能更详尽。
- **置信度**：高（三个 service 入口 + 两个路由层全部读码确认无门禁）。
- **修复**：把"竞赛上下文门禁"下沉到 service 层——createSubmission/createArtifactSubmission/createSelfTest 发现 problem_id 属于 running 竞赛时校验参赛者身份+窗口+计数，或拒绝非竞赛路径提交竞赛题。
- **置信度**：高（机制）；危害取决于 evaluate.py → 总评中。
- **修复方向**：contest 题在 running 期间禁 self-test（把 contest_id/竞赛状态传入 createSelfTest 并校验）；或自测响应脱敏（剥 details 中 expected 类字段）；或自测计入该题提交限制。


## 二、子代理发现（对抗复核通过）

### F-06 【高】LLM 题共享日预算可被"关门"——冻结他人 LLM 题得分（gateway 子代理 G1，复核通过）
- **位置**：noj-llm-gateway/src/limits.ts:333-376（每笔调用同时计 per-submission + user/global/problem 日桶）
  noj-llm-gateway/src/db/seed.ts:33-49（默认：user/day 1000 calls、problem/day 5000 calls、global 更高）
  noj-llm-gateway/src/routes/llm.ts:252-275（settle 超限 → out_of_usage）
- **利用链**：LLM 平台题开赛后，攻击者对同一题反复提交，每次提交内 solution/evaluator 循环调用 llm.complete 打满单提交预算（max_calls，每提交重置，互不累计）→ 耗尽**全选手共享**的 problem/day(5000) 与 global/day 桶 → 此后任何选手评测中 LLM 调用立即 out_of_usage → evaluate.py 无结果 → 0 分。先耗尽的一方把后提交者全部冻在 0 分。
- **代价**：真实上游调用量（平台 provider 付费，兼具财务 DoS）；需 LLM 题开放。
- **置信度**：高（结构实测确认；注意与子代理报告数值差异：实测 problem/day=5000、user/day=1000）。
- **修复**：补"每用户×题目"累计维度预算；或共享桶不设"全题 5000"这种可被单选手打光的量级。

### F-07 【高】评测并发 2 槽 + 全局单队列——选手可拖死他人评测时序（judge 子代理 J1，复核通过）
- **位置**：noj-judge/src/main.rs:115（Semaphore::new(max_concurrent_judges)）+ config.rs:82（DEFAULT_MAX_CONCURRENT_JUDGES=2）+ mq.rs:33（全局单 FIFO BRPOPLPUSH）
- **利用链**：普通代码提交即可。对长 time_limit 题批量提交"每次调用 sleep≈call_timeout"的代码 → 每任务占满 1/2 槽位直至时限（judge 封顶 min(题设,300s)）→ 队列为全站共享 FIFO → 对手任务被整体推后。窗口制竞赛中对手无法及时出分/迭代。judge 无 per-user 背压；core 虽有提交限流（120/min）但远高于 2 槽消化能力。
- **置信度**：高（机制）；实际危害中。
- **修复**：per-user 并发/背压；或队列按用户分片/公平调度。

### F-08 【中-高】artifact zip 解压无任务级总超时 + 多份内存驻留——judge worker 可被推至 OOM（judge 子代理 J2，复核通过）
- **位置**：noj-judge/src/sandbox/download.rs:122-131（整包流式读入内存，上限 MAX_SUPPORT_PACKAGE_BYTES≈2GB）
  noj-judge/src/dual/mod.rs:163（zip_bytes.to_vec() 再复制一份）→ spawn_blocking extract_zip_entries（全部条目驻留内存）
  noj-judge/src/dual/mod.rs:386-443（注入在 evaluator exec 启动之前，30s 计时未开始 → 注入无总超时）
  noj-judge/src/dual/mod.rs:225-244（每文件 docker exec 轮询上限 50×100ms=5s）
- **利用链**：artifact 题提交 ~1000 文件/2GB 级 zip → 下载+复制+解压峰值达包体积 2-3 倍 → 默认 2 并发下两任务可推高 worker 内存至崩溃 → 评测中断、in-flight 悬挂。1000 文件注入可占槽数分钟。
- **前提**：artifact 题 + 大 zip（core 允许 2GB 硬上限）。
- **置信度**：高（机制）；可达性中。
- **修复**：解压/注入设任务级总 deadline；zip 解压改流式（边解边注入边释放）；对条目数×大小设更严上限。

### F-09 【中】solution 可无限调用 BYOK 能力烧用户额度/干扰（judge 子代理 J3，复核通过）
- **位置**：noj-judge/src/dual/mod.rs:909-916（FRAME_CAPABILITY 分支：request_user_llm_completion → handle_user_llm_capability，无调用次数上限）+ 1005-1016（judge 用该用户 BYOK eval_token 代打 gateway，30s 超时）
- **利用链**：选手在 solution 里循环发 capability 帧 → judge 用选手自己的 BYOK token 串行请求 gateway → 每次任务可无限烧 BYOK 额度；BYOK 无每任务计数上限、select! 分支内 await 不被打断。
- **代价**：BYOK 是选手自己的 key/额度（攻击者烧自己）→ 主要价值是干扰共享 gateway 限流（unknown 桶）或平台 BYOK 补贴场景。中置信。
- **修复**：per-submission 的 BYOK 调用计数上限。

### F-10 【中】gateway"unknown"共享速率桶——低成本随机 429 干扰他人 LLM 评测（gateway 子代理 G3，复核通过）
- **位置**：noj-llm-gateway/src/routes/llm.ts:86（clientIp = x-forwarded-for ?? "unknown"）；limits.ts:388-395（rate key = llm:rate:ip:unknown:分钟）
- **利用链**：judge/Evaluator 侧调用不带 XFF → 全平台 Evaluator 流量共挤一把 unknown 钥匙（默认 60/min）→ 少量高吞吐提交即让他人 LLM 评测随机 429。
- **置信度**：中（默认配置即成立）。
- **修复**：无 XFF 时按 submission/user 派生键。

### F-11 【低-中】评测输出全量回传 owner——题目把评分标准拼进 LLM 上下文即泄题（gateway 子代理 G4，复核通过，出题依赖）
- **位置**：noj-judge/src/dual/mod.rs:1103-1119（output=stdout+stderr 合并回传、details 原样透传）；907-916（solution 非 BYOK capability 帧直通 evaluator）
- **利用链**：凡 LLM 工程题把系统提示/评分标准拼进发给模型的 messages、或模型回显拼进输出/评测帧 → 选手一次提交即可完整拿回（owner 可见 8KB 截断）。平台无防回显机制。
- **置信度**：低-中（机制确凿，触发依赖题目实现）。
- **修复**：输出脱敏/评测脚本编写指引（提示词不拼秘密）。

### F-12 【中-高（前提：开注册）】注册无验证 + 仅 IP 限流——批量开号放大共享配额攻击（gateway 子代理 G2 + 主代理早前第一手确认）
- **位置**：noj-core/src/domains/identity/services/auth-register.ts:194-217（无邮箱验证直接 INSERT）
  noj-core/src/domains/system/services/hardening-rate-limit.ts:167-171（register 仅 register:ip:{ip} 单键 100/h）
  noj-llm-gateway seed：每账号独立 user/day 1000 calls 桶
- **利用链**：轮换住宅代理批量注册 → 每账号独立 user 配额桶 → F-06 的规模乘 N；或同题多账号并行压 hidden 反馈。
- **前提**：竞赛站开注册（常态）+ 代理池。
- **置信度**：高（机制）；前提依赖部署。
- **修复**：注册邮箱验证/账号维度限流/设备指纹。



### F-13 【低-中】密码房注册接口无限流/失败锁定——口令可在线爆破
- **位置**：noj-core/src/domains/contest/routes/contests.ts:166-190（POST /:id/register 无 rate limit/失败计数/锁定，对照 auth/register 的 REGISTER_LIMIT）
  noj-core/src/domains/contest/services/contests.ts:519-524（registerForContest 单次 bcrypt 比对；403 密码错误 vs 201 成功提供 oracle）
- **利用链**：对已知 public_id 的密码房循环试口令，靠 403/201 区分成败；成功后可提前注册占位或进入仅参赛者可访问的竞赛内容（题面）。
- **前提**：房口令低熵；需已知 contest public_id（8 字符 31 字母表不可枚举，但密码房 ID 可能经列表/分享泄露）。
- **影响**：闯入私密竞赛；评级低-中（bcrypt 单次比对慢 + public_id 难枚举 → 实操成本高）。
- **置信度**：高（机制确凿）。
- **修复**：register 加 IP/账号维度限流 + 失败退避（复用登录限流原语）。


### F-14 【中】客观题防泄题裁剪不一致——提交历史列表泄露竞赛卷完整 expected（objective 子代理 O3，复核通过）
- **位置**：noj-core/src/domains/objective/services/objective-submissions.ts
  - 落库：row.details = judgement.details（含每道小题 expected，未按模式剥除）
  - 单条详情：getObjectiveSubmission 对 submission_type=contest 做 stripExpected（245-260 行）
  - 列表：toSubmissionResponse 对 row.details 原样直出（207-222 行）；listObjectiveSubmissions 用 toSubmissionResponse 映射 → **列表响应含完整 expected**
  - 入口：catalog/routes/problems.ts:136-155（GET /problems/submissions?paper_id=），仅本人/admin（非 admin 只能查自己）
- **利用链**：竞赛中本人提交一次（一次性锁卷）→ GET /problems/submissions?paper_id=<卷> 读自己提交历史 → 列表响应 details 含**整卷每道题 expected（含未答/答错题）** → 复盘/马甲号满分提交。与"单次提交+竞赛不展示答案"（详情端点剥、返回剥）的规则冲突。
- **前提**：本人已有一次竞赛提交；仅查自己（无越权他人）。
- **影响**：answer-recon 通道；跨账号（马甲）场景等于 O1 的廉价替代；平台"竞赛不展示解析/答案"承诺在列表路径失效。
- **置信度**：高（insert 未剥、list 未剥、detail 剥三处不一致逐行可验证）。
- **修复**：落库即按模式剥 expected（只存 strip 后 details），或列表端点与详情统一 strip；响应层不再依赖"调用方记得剥"。


### F-15 【中-高】全站评测队列概览无竞赛过滤——运行中竞赛进度具名实时可见（submission 子代理 S1，复核通过）
- **位置**：noj-core/src/domains/submission/routes/queue.ts:17-20（GET /api/v1/queue 仅 authMiddleware；文件头注释 13-15 自认"若比赛要求更严格可见性可在此加脱敏"而未加）
  noj-core/src/domains/submission/services/queue.ts:288-447（getQueueOverview：pending/judging/recently_completed 查询全部无 contest_id 过滤；submissions 与 self_tests 两表合并，含 user_id/题目/语言/状态/时间戳，recently_completed 的 self-test 分支含 score）
- **利用链**：任意登录用户 GET /api/v1/queue → 看到全站（含 running 竞赛）每个具名选手的提交/自测（judging 与 recently_completed，username/user_id + problem_id + 时间），拿 UUID 再 GET /submissions/:uuid 补 score → 运行中竞赛对手的每题尝试节奏与得分进度实时可见（自测动作也混入，能看出谁在调试哪题）。
- **前提**：仅需登录；无需参赛。
- **影响**：与"running 期榜单仅本人可见"（contest-ranking.ts:210-218）设计直接矛盾——比 F-02（SSE+详情）更直接的聚合情报入口。
- **置信度**：高（路由+服务层代码直读确认无过滤）。
- **修复**：queue 概览对 running 竞赛提交做脱敏（contest_id 非空且竞赛 running → 隐藏 user/score），或竞赛隔离到专用队列视图。

## 三、被证伪/排除的候选（避免误报，记录在案）
- 支持包下载（GET /problems/:id/support-package）→ 有权限闸（support-package.ts:162-171：owner 需 package_manage_own，非 owner 需 package_manage_any）→ 普通选手无法下载含 hidden.jsonl 的包。已排除。
- objective 竞赛模式正式提交 → 有 running/注册/一次性提交三重守卫 + 唯一索引 23505 兜底（objective-submissions.ts:50-81）→ 排除。
- contest 提交 multipart 分支缺限次 → artifact 路径同样调 assertContestSubmissionLimit（artifact-submissions.ts:122-129）→ 排除。
- **【contest 子代理 D1[1] 证伪】"普通提交接口伪造 contest_id 赛前入榜"**：子代理称 POST /api/v1/submissions 把 body.contest_id 直传 createSubmission。复核：路由层（submissions.ts:182-226）仅提取 problem_id/language/code/file_name/llm_provider_config_id，**不提取 contest_id**；multipart 分支解析器（parseArtifactMultipart）同样无 contest_id 字段；生产代码 createSubmission 仅 3 个调用点（普通 JSON 路由 / artifact 路由 / contest 路由显式传参）。服务层 SubmissionInput.contest_id 仅由 contest 路由（带 running/participant 门禁）填充。→ 无客户端入口可伪造 contest_id，假阳性剔除（其榜单 SQL 无 start_time 下界观察仍有效，见 F-15 前瞻/遗留）。