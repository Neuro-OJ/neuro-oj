# 面 1.4 — noj-core 数据泄露（全域读路径矩阵）审计报告

> 审计面：noj-core 数据泄露（全域读路径矩阵） ｜ 类型：II 二次审计 ｜ 派发时间：2026-09-29 07:45 ｜ 返回时间：2026-09-29 07:52
> 审计员：subagent（只读：仅 rg/read，未运行服务/测试/迁移）
> 复核：**Lead 亲自复核**（时间盒所限未另派 verifier —— 见文末「复核口径说明」）
> 审计基线：`origin/main` = `6dbdd76b`（含 9-28 的 VULN-01..22 整改）

## 判据

- **保密窗口**：题目被加入任一**未结束的公开赛**（`kind='public' AND now < end_time`，**含 pending 赛前筹备期**）时，非特权用户与匿名必须看不到：题面/标题/难度/标签/存在性、隐藏用例与标准答案、他人提交与结果、他人得分与排队位置、判分 oracle。
- **本面特有判据**：上一轮对泄露的修法本质是**"枚举读路径 + 注入过滤谓词"** —— **漏掉任何一条读路径就等于没修**。因此本面交付物是**穷举矩阵**，而非复述已修清单。

## 1. 读路径矩阵（`noj-core/src/domains/*/routes/*.ts` 全量逐条）

「受管辖」= 是否走 `problem-secrecy` 三出口（`unendedPublicContestForProblem` / `isProblemInUnendedPublicContest` / `filterUnendedContestIds`）或等价的 `evaluateProblemAccess`。

### 1.1 题库 / 题目面（catalog）

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /problems（列表） | 是 | `problems-list.ts:210-215`（非 admin 注入 NOT unended… OR owner_id=viewer），计数同一 `whereClause:273` | ✅ 行、计数、title/description/difficulty 全遮蔽 |
| GET /problems/:id（详情，双索引） | 是 | `problems.ts:206-238` + `problem-access-check.ts:43-58` | ✅ 404；仅 owner/admin 得 `contest_secrecy` |
| GET /problems?tag=&keyword=&owner_id=&number= | 是 | 同一 handler（含 owner_id 旁路 `problems-list.ts:194-204`） | ✅ |
| GET /problems/:id/stats/public | 是 | `problems.ts:535-556`（与详情同口径 404） | ✅ 不可当存在性预言机 |
| GET /problems/:id/stats（深度） | 是（间接） | `problems.ts:559-570` owner/admin | ✅ |
| GET /problems/:id/support-package | 是 | `problems.ts:439-470`（`mode==="contest-secret"` → 404） | ✅ 且不返回 storage_url |
| GET /problems/:id/template | 是 | `problems.ts:495-535` | ✅ 404 |
| GET /problems/:id/questions（客观题） | 是 | `problems.ts:602-630` → `objective-questions.ts:186-210`；`?contest_id=` 只信 contest 上下文（`problem-access.ts:88-95` 不回退 public） | ✅ 伪造 contest_id 无效 |
| GET /problems/submissions（客观题提交） | 部分（VULN-03） | `problems.ts:162-179`；`objective-submissions.ts:399-402` 非 admin 忽略 `user_id` 参数；竞赛剥离 `:447-465` | ✅ 仅本人；赛中 score=null、去对错（fail-closed 含 pending） |
| GET /problems/submissions/:id | 部分 | `objective-submissions.ts:315-338` | ⚠️ 非本人 **403**（非 404）→ 存在性微预言机（需已知 UUID）→ **F-09** |
| GET /problems/:id/preflight（admin） | 不适用 | `admin/routes/catalog.ts:88` `admin:full_access` | ✅ 非管理员 403 |

### 1.2 题单 / 标签 / 训练共享

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /trainings（列表） | 部分 | `trainings.ts:48-79`；`countProblems:96-110` 不过滤 | ⚠️ `problem_count` 含保密题 → **F-04b** |
| GET /trainings/:id | 部分 | `trainings.ts:272-286`（题数不过滤） | ⚠️ 同上 |
| GET /trainings/:id/problems | 是 | `trainings.ts:502-556`（`is_contest_hidden!==true && visibility==='public'`，整行剔除） | ✅ |
| GET /trainings/mine、/containing | 不适用 | `trainings.ts:167-207`（均以 `created_by=viewer` 约束） | ✅ 只回自己的题单 |
| GET /tags | 部分 | `tags.ts:23-27` → `listTags:104-115` | ⚠️ `problem_count` 含保密/私有题 → **F-04c** |

### 1.3 个人主页 / 身份

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /users/:id/profile → 已通过题目 | 是 | `users-profile-queries.ts:103-141` | ✅ |
| 同上 → 最近提交（10 条） | 是 | `:150-185` | ✅ |
| 同上 → 社区统计 `solution_count`、最近题解 | **否（错误口径）** | `:197-201`、`:238-246` 用 **`runningContestExistsForProblem`**（仅 `start≤now<end`） | ❌ **赛前筹备期泄露题解标题与存在性 → F-01** |
| 同上 → `total_submissions/accepted/solved_count` | 否 | `:70-95` 无保密谓词 | ❌ 计数/列表不齐侧信道 → **F-04a** |
| GET /users/:id/avatar、/users/search | 不适用 | `users.ts:33-45,132-151`（无题目内容） | ✅ |
| GET /users/me/data-export | 不适用 | `users.ts:110-131`（本人） | ✅ |

### 1.4 提交 / 队列 / 自测 / SSE

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /submissions（本人） | 不适用 | `submissions.ts:62-107` 强制 `userId=viewer` | ✅ |
| GET /submissions/public/recent | 是 | `submissions.ts:246-270` `excludeContest:true` | ✅ 竞赛提交不进公开流 |
| GET /submissions/today-stats | 不适用 | `:272-289` | ✅ |
| GET /submissions/total-stats | **否** | `:291-303` + `stats-cache.ts:25-52` 无 contest 过滤 | ❌ 满分数全局增量＝判分 oracle 旁路 → **F-05** |
| GET /submissions/:id | 是（投影） | `submissions.ts:306-340` → `submission-projection.ts:74-100`（赛中他人仅 id/problem_id/status；旧数据 fail-safe 全剥） | ✅ |
| GET /submissions/:id/status | 是 | `submissions.ts:348-362`；`queue.ts:659-661` 非 admin 必须 owner | ✅ |
| GET /queue | 是 | `queue.ts:426-429,472-475,531-535,590-596` 非 admin 全面 `isNull(contest_id)`；`selfTestScope:368-375` fail-closed | ✅ |
| GET /submissions/:id/events（SSE） | 是 | `submission/routes/sse.ts:52-57` 归属校验（他人 403），重放同权限 | ✅ |
| GET /queue/events（SSE） | 是 | `submission/routes/sse.ts:111-140` 无载荷 | ✅ |
| GET /submissions/stats/events（SSE） | **否** | `query/routes/sse.ts:20-75` + `stats-cache.ts` | ❌ F-05 实时推送侧信道 |
| POST /problems/:id/self-test | 是 | `self-tests.ts:70-86` `evaluateProblemAccess` | ⚠️ 拒绝时 **403** vs 不存在 404 → **存在性预言机 F-03** |
| GET /self-tests/:id | 是（归属） | `self-tests.ts:186-196` 非 owner/admin 404 | ✅ |
| artifact 下载 | 不适用 | 无该路由；评完即删（`submissions-result.ts:228-243`） | ✅ |

### 1.5 竞赛面

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /contests（列表） | 部分 | 只出 `is_public=true`（`contests.ts:653,668`），含 `problem_count/participant_count`（`:609,665`） | ⚠️ 匿名可见赛题**数量** → **F-06** Low |
| GET /contests/:id | 部分 | `contests.ts:494-503`；`getContest:604-608` 返回 `problem_count` | ⚠️ 同上（不含标题/描述） |
| GET /contests/:id/problems[/:label] | 是 | `contests.ts:212-249` → `requireContestAccess:135-146`（非参赛者 403、**pending 403**） | ✅ 赛前/场外均不可读 |
| GET /contests/:id/ranking | 是 | `contest-ranking.ts:594-644`（守卫先于视图判定；封榜期非 admin 仅本人一行） | ✅ VULN-09 已修 |
| GET /contests/:id/final-ranking | 是 | `contests.ts:294-330` + 快照仅 ended 发布 | ✅ |
| GET /contests/:id/my-submissions | 是 | `contests.ts:408-427` 需参赛 + 强制 owner | ✅ |
| GET /contests/:id/clarifications | 是 | `contests.ts:433-457` + `contest-clarifications.ts:352-378` | ✅ VULN-01 已修 |
| GET /contests/:id/events（SSE 实时+重放） | 是 | `contest/routes/sse.ts:170-215`（实时剔 user_id+submission_id；**重放同口径**；非成员仅 ranking） | ✅ VULN-10 已修 |
| GET /admin/contest/**（submissions/anti-cheat/snapshots/participants） | 不适用 | `admin/index.ts:31-40` 组级 adminMiddleware | ✅ 非管理员 403，无静默过滤 |

### 1.6 搜索 / 社区 / 通知 / 系统 / 其它

| 读路径 | 受管辖 | 证据 | 裁定 |
|---|---|---|---|
| GET /search（flat + grouped） | 是 | `search.ts:79,138` 同时注入 `contestSecrecyProblemWhere`（`permission-filter.ts:44-56`）与 `notGatedContestContentWhere`（`:82-107`，覆盖 solution+discussion+comment） | ✅ 无第三处查询 |
| GET /community/posts（列表） | 是 | `community-post-list.ts:100` + `community-post-common.ts:100-104` | ✅ |
| GET /community/posts/:postId | 是 | `community-post-crud.ts:301-317`（solution/discussion + 未结束公开赛 → 404，**含作者本人**） | ✅ |
| GET /community/posts/counts | 是 | `community-post-list.ts:214-222`（计数与列表同谓词） | ✅ 无计数侧信道 |
| GET /community/bookmarks | 是 | `:234-241` | ✅ |
| GET /community/solutions/eligibility | 是 | `community.ts:232-256`（`isProblemInUnendedPublicContest` 含 pending） | ✅ |
| GET /community/feed | 不适用 | `community-feed.ts:25-31` 硬过滤 `type='moment'` | ✅ 结构上无关 |
| GET /community/config、/boards、comments、/notifications*、/reports | 不适用 | `community.ts:117-150,368-386,541-660` | ✅ 不含保密题内容 |
| GET /announcements、/:id、/banner、/events | 不适用 | `system/routes/announcements.ts:33-95`（无题目外键） | ✅ |
| GET /stats | **否** | `query/routes/stats.ts:22-45` 全表 count | ⚠️ 全局聚合存在性计数 → **F-07** Low |
| GET /rankings | **否** | `query/services/rankings.ts:253,265,281,298,355,367,383` 无时间窗口；`submissions-result.ts:254` 每次结果 REFRESH | ❌ **F-02 High** |
| GET /rankings/me、/rankings/checkin | 不适用 | `rankings.ts:43-70` | ✅ |
| /admin/dashboard、/admin/audit-logs、/admin/settings、/admin/judge-images、/admin/llm/** | 不适用 | `admin/routes/system.ts:156,229,304` 等 | ✅ |
| /admin/catalog/**、/admin/community/** | 不适用 | `catalog.ts:228,263,445`；`community.ts:97,115,134` | ✅ 各自 assertPermission |
| /health、/health/ready | 不适用 | `observability/routes/health.ts:23-110` | ✅ |
| /auth/**、/checkin/**、/oauth/** | 不适用 | `identity/routes/*` | ✅ 无题目/提交读取 |
| /legal/**、/conversations/**、/data-policy、/site/meta、/slides | 不适用 | `legal/*`、`messaging/routes/conversations.ts:62-423`（会话会员校验） | ✅ |

## 2. findings

| id | 严重度 | 位置 | 触发路径 / 最小 PoC | 泄露什么、谁能看到 | 与上一轮关系 |
|---|---|---|---|---|---|
| **F-01** | **High** | `identity/services/users/users-profile-queries.ts:197-201`、`:238-246` | 赛前筹备期（公开赛 `start_time` 未到、题已挂 `contest_problems`）→ 匿名 `GET /api/v1/users/<uid>/profile`，读 `community.solution_count` 与 `solutions[].title` | 该题**题解标题**与"已有题解"的存在性；匿名 + 任意登录用户；uid/username 可枚举 | **VULN-02 的赛前窗口未覆盖**（新发现）：community/search 已改 `unended`，个人主页仍是 `running` → 全仓两份可互换判定 |
| **F-02** | **High** | `query/services/rankings.ts:253,265,281`（+物化视图 `:355,367,383`）；`submission/services/submissions/submissions-result.ts:254` | 未结束公开赛且 `affect_global_ranking=true` 时，匿名 `GET /api/v1/rankings`（无限流、无需登录）轮询某选手 `solved_count/total_submissions/acceptance_rate`；每次评测结果即 REFRESH 视图 | 赛中**他人得分/进度/排名**（参赛者名 + 增量），正是竞赛榜用"仅本人一行"保护的信息 | 新发现（全站榜单与竞赛窗口的交叉，上一轮未涉及） |
| F-03 | Medium | `submission/services/self-tests.ts:70-86`（`:84`） | 登录用户 `POST /api/v1/problems/P1001/self-test`：保密题 → **403**；不存在题 → **404**；公开题 → 201 | 被未结束公开赛收编题目的**存在性**（display_id 可枚举） | **VULN-07 残余**（兄弟路径都 404 化了，漏了自测） |
| F-04 | Medium | (a) `users-profile-queries.ts:70-95`；(b) `catalog/services/trainings.ts:96-110`、`:284` vs `:536`；(c) `catalog/services/tags.ts:104-115` | (a) `stats.solved_count=5` 但 `solved[]` 只 4 行 → 差额即"存在一道保密题且该用户已通过"；(b) `problem_count` > 列表长度；(c) 标签 `problem_count` 含保密题 | 存在性 + 他人赛中通过进度（计数侧信道）。同文件 `:186-193` 注释已自认"计数与列表口径必须一致"，但该原则未施加到这三处 | **VULN-07 残余**（新发现） |
| F-05 | Medium | `submission/routes/submissions.ts:291-303`；`query/routes/sse.ts:20-75`；`stats-cache.ts:25-52` + `submissions-result.ts:250` | 匿名轮询 `GET /api/v1/submissions/total-stats` 或订阅 `/submissions/stats/events`：`full_score` 增量 = "刚刚出现一次满分提交" | 他人满分事件计数/时序；对参赛者构成**判分 oracle**，绕过 VULN-03"赛中不回显对错"的意图 | **VULN-03 已修但仍可绕过**（旁路是全局聚合，不是提交回显） |
| F-06 | Low | `contest/services/contests.ts:609,665` | 匿名 `GET /contests`、`/contests/:id`（含 pending）读 `problem_count` | 赛题**数量**（无标题/ID 列表） | 新发现（加固） |
| F-07 | Low | `query/routes/stats.ts:22-45` | 匿名 `GET /stats` | 全站题目/提交计数含私有与保密题（不可定位） | 新发现（加固） |
| F-08 | Low | `catalog/services/problem-access.ts:86` | —（注释与实现矛盾） | 注释断言"题库列表不排除该题，故存在性本身不保密"，与 `problems-list.ts:210-215` + 404 化实现**直接矛盾** → 后续维护者可据此合理删掉列表过滤 | 新发现（**回归风险**，文档漂移） |
| F-09 | Low | `objective/services/objective-submissions.ts:316` | 客观题 `GET /problems/submissions/:id` 他人提交 → 403（非 404） | 客观题提交 UUID 存在性（需先拿到 UUID） | 新发现（加固） |

## 3. 结论

### ① 已审但未发现问题的子面（检索词 + 命中）

- **无随机题/每日推荐/搜索建议旁路**：`rg "random|recommend|autocomplete|suggest"` → 仅 `crypto.randomUUID` 与内容审核的 `suggestion` 字段；行为描述二次检索 `"ORDER BY random|RANDOM\(\)|daily|每日|推荐"` → **0 命中**。
- **无非特权导出面**：`rg "csv|export"` 路由层 → 仅 `admin/routes/contest.ts:702-742`（adminMiddleware 覆盖）与 `/users/me/data-export`（本人）；二次检索 `"Content-Disposition|text/csv"` 同上。
- **对象存储直链/presigned 未外泄**：`rg "presign|downloadUrl"` 在 `domains/*/routes` → **0 命中**；公开 DTO 仅 owner/admin 带 `support_package_storage_url`，非特权只有布尔 `has_support_package`；客户端直传被拒（`problems.ts:260-267`）。
- **SSE 重放与实时同口径**：contest 实时 `sse.ts:170-186` 与重放 `:195-215` 都剔 `user_id`+`submission_id`；`/queue/events`、`/stats/events` 载荷无用户标识。
- **搜索/社区计数无第三口径**：`permission-filter.ts` 三谓词 → `search.ts:79,138` 两处；`community-post-list.ts:100,219,238` 三处（列表/Tab 计数/收藏）全部同谓词。
- **管理端无降级静默过滤**：组级 `admin/index.ts:31-40` + 各细粒度前缀 `assertPermission` → 非管理员一律 403。

### ② 上一轮 VULN 逐条裁定

| 项 | 裁定 | 依据 |
|---|---|---|
| VULN-01 答疑广播 | **维持已修** | `contest-clarifications.ts:206,221` 固定 `is_public:false`；仅显式公开回复提升根提问 `:283`；`listClarifications:353-378` 仅 manager/is_public/提问者 |
| VULN-02 题解讨论门控 | **仍可绕过（赛前窗口）** | community/search/eligibility 均已 `unended` ✅；个人主页 `users-profile-queries.ts:200,242` 仍是 `running` → **F-01** |
| VULN-03 客观题即时回显 | **维持已修，但可旁路** | `objective-submissions.ts:320-338`、`:447-465` 用 `filterUnendedContestIds`（fail-closed 含 pending）✅；旁路 = **F-05** |
| VULN-07 聚合页泄露 | **维持已修（残留计数/存在性）** | 题库/题单/主页已通过/最近提交/搜索/社区详情全部 ✅；残留 **F-03 / F-04 / F-08** |
| VULN-09 封榜期隐私倒挂 | **维持已修** | `contest-ranking.ts:594-608` 身份守卫前置于视图判定；封榜期非 admin 仅本人一行 |
| VULN-10 提交监听链 | **维持已修** | 实时与重放同口径剔双标识；`submission/routes/sse.ts:52-57` 订阅前归属校验 |
| VULN-11/13 队列与权限倒挂 | **维持已修** | `getQueueOverview` 非 admin 四处 `isNull(contest_id)` + `selfTestScope` fail-closed；`getSubmissionQueueStatus` 非 admin 必须 owner |
| VULN-04/05 邀请赛/私有赛挂公开题 | **维持设计口径（不构成新增泄露）** | `problem-secrecy.ts:14-17` 显式规定 `kind='invite'` 不参与保密；被挂的公开题本身已是公开内容。**但** F-02 的全局榜单与私有赛交叉未加窗口判定，建议与 F-02 一并处理 |

### ③ 结构性结论（本轮最重要的一条）

VULN-02 的整改在 community / search 换成了 `unended` 口径，却在 identity 个人主页留下
`running` 旧口径（`runningContestExistsForProblem`）—— 这正是"枚举读路径 + 注入谓词"修法的
失效点：**同一份"未结束公开赛"事实在仓库里仍有两个可互换的 SQL 出口**，其中一个把 pending
当可见。**同类风险并未穷尽**（F-03/F-04/F-06/F-07 都是"某条路径没走同一出口"的变体），因此
建议的收敛动作是：让 `runningContestExistsForProblem` 若无非保密用途则废弃或改为
`unendedWindowCondition`，并在门禁层面禁止新增手写时间窗口比较。

## 复核与处置（Lead 亲自复核，时间盒内未另派 verifier）

本面 finding 数 **9 > 5**，按 spec §5.4 应另派 verifier subagent 做证伪复核。**本轮未派**
（08:45 硬停前的余量只够"审计 + 修复 + 门禁"），改由 **Lead 逐条读证复核**。按 L1 口径，
凡未经复核的结论**不得视为已确认缺陷**；下表逐条给出 Lead 的复核状态与处置。

| id | Lead 复核 | 处置 | 证据 |
|---|---|---|---|
| **F-01** | **确认成立** | ✅ **已修**：两处调用点改用 SSOT 的 `unendedPublicContestForProblem` | `evidence/04-F01-profile-gating.txt`（反向验证：撤掉修复 → FAILED，断言信息即"赛前筹备期不得泄露题解标题"） |
| **F-02** | **确认成立**（读证：`rankings.ts` 共 7 处 `(s.contest_id IS NULL OR c.affect_global_ranking = TRUE)`，**无任何时间窗口条件**；`/api/v1/rankings` 匿名可读） | ⏸ **未修，出补丁提案**（见下） | `rankings.ts:253,265,281,298,355,367,383` |
| **F-03** | **确认成立**（读证：`self-tests.ts:75` 不存在→404，`:84` 访问被拒→403） | ✅ **已修**：仅对 `access.mode === "contest-secret"` 改抛 404，其他拒绝语义不变 | `evidence/04-F03-selftest-404.txt`（反向验证：撤掉 404 分支 → `Expected NotFoundError, but was ForbiddenError`） |
| F-04 | **部分确认**：`(a)` 主页 stats 查询（`total_submissions/accepted/solved_count`）确无保密谓词；`(b)(c)` 未逐行复核 | ⏸ 未修（计数口径不齐，Low-Med） | `users-profile-queries.ts:70-95` |
| F-05 | **路由层确认**：`/submissions/total-stats` 无竞赛过滤；**oracle 可利用性未实测** | ⏸ 未修 | `submissions.ts:291-303` |
| F-06 / F-07 | 未复核 | ⏸ 未修（Low） | — |
| **F-08** | **确认成立**（读证：注释与 `problems-list.ts:210-215` 实现直接矛盾） | ✅ **已修**：改写为"存在性同样受保护"，并写明不得据旧注释删掉列表过滤 | `problem-access.ts:84-93` |
| F-09 | 未复核 | ⏸ 未修（Low） | — |

### F-02 补丁提案（未实施，需 Owner 裁决）

**为什么不在本轮实施**：正确修法要同时动 **7 处 SQL**、向 contest 域门面新增窗口谓词导出
（`unendedWindowCondition` 目前**未**从 `index.ts` 导出），并**改变全局榜单的语义**
（未结束竞赛的提交是否计入全站榜是一个产品决策）——属 spec §7「设计级变更」，不在无人值守
窗口的自主修复范围内。

**提案**：全局榜只统计"已结束竞赛"的提交，与竞赛榜自身的隐私规则（进行中只给本人一行）
对齐：

1. `noj-core/src/domains/contest/index.ts` 的 contest-window 导出块新增
   `unendedWindowCondition`（已存在，只是未导出）。
2. `rankings.ts` 的 7 处条件由
   `(s.contest_id IS NULL OR c.affect_global_ranking = TRUE)`
   改为
   `(s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND NOT ${unendedWindowCondition(sql`c.end_time`)}))`
   —— 用 SSOT 谓词，**禁止**再手写时间比较（`noj-core/AGENTS.md` 明文）。
3. 回归测试：`contest/query` 域各一条 —— 「进行中公开赛（`affect_global_ranking=true`）的提交
   **不**计入全局榜」与「赛后**计入**」。
4. 行为变化与回滚：全局榜数字在竞赛期间会变化（这是修复目的）；回滚 = revert 该 change。
5. 交叉项：`VULN-04/05`（私有/邀请赛挂公开题）与 F-02 的交叉未判定，需一并确认
   `affect_global_ranking` 在私有赛下的语义。

**为什么不建议"改为登录可见"**：泄漏面是"任何登录用户/匿名都能看到他人的赛中进度"，
加登录门槛不解决跨用户泄漏，只会缩小攻击面。

