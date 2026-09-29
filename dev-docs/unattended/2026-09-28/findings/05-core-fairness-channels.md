# 面 1.5 — noj-core 赛时公平性信道审计报告

> 审计面：赛时公平性信道（串通/交流解法/探测他人进度） ｜ 类型：II 二次审计
> 派发：2026-09-29 08:12 ｜ 返回：2026-09-29 08:22 ｜ 审计员：subagent（只读）
> 复核：**未经独立复核**（截止 08:45 前无余量；按 L1 口径下列结论为**单方证据**）
> 范围排除（Owner 明确）：**反作弊系统的功能设计与改进不在范围内**

## 1. 信道矩阵

| 信道（端点/字段） | 赛中可用 | 能传递/推断什么 | 证据 file:line | 裁定 |
|---|---|---|---|---|
| `POST /community/posts` `type=discussion`（**省略 problem_id**） | ✅ 登录即可 | 最高 20000 字符任意文本 → **向全场广播完整解法**；无任何竞赛门控 | `community-post-crud.ts:142-153,167,208`；`community-post-common.ts:100-106`；`community/routes/community.ts:275-287` | **可被利用（Critical）** |
| `POST /community/posts` `type=moment` | ✅ | 1000 字符/条、间隔默认 0（无限发）→ 广播信道 | `community-post-crud.ts:167`；`settings-registry.ts:779-805` | **可被利用** |
| `POST /community/posts/:id/comments` | ✅ | 10000 字符评论，**完全无竞赛门控**（只判 `is_locked`） | `community-comments.ts:128-135` | **可被利用** |
| `POST /community/reports`（回显被举报正文） | ✅（pending 窗口） | 赛前筹备期可读到读路径已 404 的题解**全文** | `community-moderation.ts:99-107,130-140,583-592` vs `problem-exposure.ts:32-56` | **可被利用（Medium）** |
| 答疑 `POST /contests/:id/clarifications` | 赛期 | 提问默认私密；公开仅主办方回复触发 | `contest-clarifications.ts:204-206,238-262,283-287` | 受控 |
| 答疑列表 `GET /:id/clarifications`（匿名） | 赛中 | 仅 `is_public` 行 + 本人私密行 | `contest-clarifications.ts:354-380`；`routes/contests.ts:433` | 受控 |
| 私信 `/conversations/*` | ✅ | 1:1 定向通道（无群聊），全域 authMiddleware | `messaging/routes/conversations.ts:43` | 受控（信道天然存在，非缺陷） |
| 公告 | ❌ 选手不可发 | 仅管理员 | `admin/routes/system.ts:120`；`admin/index.ts:36-46` | 受控 |
| 题单/训练共享 | 赛中 | 已注入保密谓词，整行剔除 | `catalog/services/trainings.ts:521` | 受控 |
| 全局搜索 | 赛中 | 已注入保密谓词 | `search/services/permission-filter.ts:53,90,102` | 受控 |
| 个人简介 `PUT /users/me {bio}`（匿名可读） | ✅ | 5000 字符，10 次/30s，与竞赛**无关且无门控** | `identity/routes/users.ts:47-57`；`users-profile-edit.ts:20` | **可被利用（Medium）** |
| 头像 `POST /users/me/avatar`（匿名可读） | ✅ | 2MB 原始字节**不重编码/不剥元数据**（PNG `tEXt` 可藏解法）；ETag=checksum 可做"有新内容"信令 | `users-avatar.ts:100-118`；`identity/routes/users.ts:60-77,129-140` | **可被利用（Medium）** |
| 自建邀请赛 `description` | ✅ | 成员可读任意文本；非成员 404（邀请码可散播） | `contest/types/contests.ts:120-121,146-147` | 不确定（信道级） |
| 竞赛排名 `GET /contests/:id/ranking` | 赛期 | 非 admin 恒"仅本人一行"，封榜同口径；匿名得空 | `contest-ranking.ts:594-625` | 受控 |
| 全站榜单 `GET /api/v1/rankings`（匿名） | 赛中 | 实名逐用户 `total_submissions`/`acceptance_rate`/`rank`（无时间窗口） | `query/services/rankings.ts:249-258`；`query/routes/rankings.ts:22-38` | **可被利用（= F-02）** |
| 他人主页 `GET /users/:id/profile`（匿名） | 赛中 | `total_submissions/accepted` + 最近 10 条提交的题目标题/状态/**score**；只遮挡"未结束**公开**赛" | `users-profile-queries.ts:80-110,122-170` | **可被利用（配合 N-03）** |
| 竞赛 SSE `contest:submission:created` | 需已报名 | 保留 `problem_id`（"某题刚有人提交"），已剔 `user_id`+`submission_id` | `contest/routes/sse.ts:186-215` | 受控（仅聚合信号） |
| 提交 SSE `/submissions/:id/events` | ❌ | 订阅前归属校验 403 | `submission/routes/sse.ts:51-62` | 受控 |
| `GET /submissions/:id`（他人） | 需 UUID | 返回他人 `score/time_ms/memory_kb`（code/output/details 置空）；`public_id` 8 位随机 | `submissions-crud.ts:578-620` | 不确定（不可枚举，Low） |
| `/submissions/public/recent` | 匿名 | 已 `excludeContest` | `routes/submissions.ts:238-262` | 受控 |
| `/stats`、`/submissions/total-stats`、`/queue.pendingCount` | 匿名/登录 | 全局计数（含竞赛），仅能推断"平台有人刚提交/通过" | `query/routes/stats.ts:24-45`；`routes/submissions.ts:283-297`；`queue.ts:459` | 受控（Low） |
| 题目页通过率 `GET /problems/:id/stats/public` | 匿名 | 访问校验与详情同口径（404） | `catalog/routes/problems.ts:535-556` | 受控 |
| 客观题提交回执/详情 | 赛期 | 竞赛回执 `score/correct_count=null` + 只留 `given` | `objective-submissions.ts:234-256,320-345` | 受控 |
| 自测 `POST /problems/:id/self-test` | ✅ | 前置 `evaluateProblemAccess`，无越权 oracle | `routes/self-tests.ts:26-67`；`services/self-tests.ts:79-90` | 受控 |
| 提交次数上限（每赛每题） | 服务端 | Redis INCR 强制（artifact 同） | `contest/services/contests.ts:833-856`；`artifact-submissions.ts:129` | 受控 |
| 重测 rejudge | ❌ | admin 组级守卫 | `admin/routes/submission.ts:137-150` | 受控 |
| 赛前/赛后/迟到提交 | 服务端 | 路由 + 服务层双判 running | `routes/contests.ts:337-350`；`submissions-crud.ts:356-371`；`contest-access.ts:53-56` | 受控 |
| `contest_id` 注入（通用提交路由） | ❌ | 不读 body 的 contest_id | `routes/submissions.ts:224-236` | 受控 |

## 2. Findings

| id | 严重度 | 位置 | 最小 PoC | 影响 | 与上一轮关系 |
|---|---|---|---|---|---|
| **N-01** | **Critical** | `community-post-crud.ts:167,208`；`community-post-common.ts:100-106`；`community-comments.ts:134` | `POST /api/v1/community/posts {"type":"discussion","title":"A 题","content":"<完整 AC 代码>","board_id":"<general>"}` → 201（无 `CONTEST_SECRECY`）；随后 `GET /api/v1/community/posts?type=discussion` 全场可见。同法 `{"type":"moment",...}` 或对任意 moment 帖发评论 | 任何登录用户在赛中以 20000 字符/条、间隔 0 的频率向全场广播解法。**双重结构性失效**：①写门控条件是 `type !== "moment" && input.problem_id` → **省略 problem_id 即绕过**；②discussion 落库 `problem_id` 恒为 NULL，而读门控要求 `problem_id IS NOT NULL` → 所有读路径（列表/详情/收藏/Tab 计数）对它**永远放行** | **VULN-02「已修仍可绕过」**：门控被"省略一个字段"绕过，且绕过后的内容不在任何 read gate 的判定域内 |
| **N-02** | Medium | `community-moderation.ts:99-107,130-140,583-592` vs `problem-exposure.ts:32-56` | 赛前从题解页记下 `post_id`（或先收藏）→ 竞赛 pending 期间 `POST /api/v1/community/reports {"post_id":"..."}` → 响应含 `content_snapshot` 全文（此时 `GET /community/posts/:id` 已 404） | 赛前筹备期读取本应保密的题解全文；该路径 `type==='solution'` 限定 + 手写窗口，未走 SSOT | **新发现**：VULN-02 整改遗漏的**第三处手写窗口**（口径漂移） |
| **N-03** | **High** | `problem-secrecy.ts:85-95`（硬编码 `kind='public'`）；`contests.ts:288`；`community-post-crud.ts:172-177`；`users-profile-queries.ts:40-56,122-170` | 邀请赛进行中：①`GET /problems/<竞赛题>` 正常返回，其**已有公开题解/讨论**同样正常返回；②参赛者 `POST /community/posts {"type":"solution","problem_id":<题>,"content":"<解法>"}` → **201 不被拒**（`isProblemInUnendedPublicContest` 为 false）；③匿名 `GET /users/:id/profile` 见对手实时 `recent_submissions.result_score` | 邀请赛/私有赛**完全落在保密 SSOT 之外**：不仅是"挂公开题不受遮蔽"，而是同一 `kind` 过滤同时使 VULN-02 写门控、VULN-07 主页/搜索/题库遮蔽**全部失效** → 邀请赛=公开题库+公开题解，且进度可被匿名围观 | **VULN-04/05 明确裁定：升级为 High**（上轮"维持现状"不成立）。建议把谓词扩为 `kind IN ('public','invite','private')` 或引入 `masked` 标记 |
| **N-04** | Medium | `identity/routes/users.ts:47-57,129-140`；`users-avatar.ts:100-118`；`users-profile-edit.ts:20` | `PUT /users/me {"bio":"<base64 解法>"}`；或上传含 PNG `tEXt` 块的 2MB 头像 → 他人/匿名读取（ETag 变化即"有新内容"信令） | 匿名可读、与竞赛完全解耦的 covert 公告板/文件投递；无赛期门控或内容抽检 | 新发现（信道级；加固建议） |
| **N-05** | Low | `routes/stats.ts:24-45`；`routes/submissions.ts:283-297`；`queue.ts:459` | 匿名轮询 `/stats`（含竞赛提交/通过数）、`/submissions/total-stats`；登录轮询 `/queue.pendingCount` | 仅能推断"平台有人刚提交/刚通过"，无身份无题目 | 新发现（加固建议） |
| **T-01** | Low | `catalog/services/problems/problems-stats.ts:257`；`community-moderation.ts:*`（同 N-02） | 通过率抑制仍用 `isProblemInRunningContest`（running 窗口、**无 kind 过滤**），与 SSOT（unended + public）不一致 | 公开赛 pending 期不抑制（实际被 404 挡住）；邀请赛语义相反 → **口径漂移残余两处** | 新发现（方向 5 结论） |

## 3. 上一轮结论逐条裁定

| 条目 | 裁定 | 依据 |
|---|---|---|
| VULN-01 答疑广播 | **维持已修** | 提问 `is_public:false` 硬编码（`contest-clarifications.ts:204-206`）；非主办方回复 403（`:250-254`）；仅公开回复置根提问公开（`:283-287`） |
| VULN-02 题解/讨论门控 | **仍可绕过（N-01，Critical）** | 写门控 `input.type !== "moment" && input.problem_id`（`:167`）→ 省略字段即绕过；discussion 落库 `problem_id=null`（`:208`）而读门控要求 `problem_id IS NOT NULL`（`community-post-common.ts:100-106`）→ 读侧永久失效；评论路径零门控（`community-comments.ts:134`） |
| VULN-03 客观题回显 | **维持已修** | 回执 `score:null, correct_count:null, details:{}`（`objective-submissions.ts:238-256`）；`stripContestJudgement`（`:320-334`） |
| VULN-09 封榜隐私倒挂 | **维持已修** | 身份守卫先于视图判定（`contest-ranking.ts:604-612`）；frozen 分支匿名空列表（`:612-625`） |
| VULN-10 提交监听链 | **维持已修** | 实时与重放同口径剔双标识（`contest/routes/sse.ts:186-215`）；订阅前归属校验（`submission/routes/sse.ts:51-62`）。残余仅"某题刚有人提交"聚合信号（Low） |
| VULN-11/13 队列泄密/权限倒挂 | **维持已修** | `selfTestScope` 非 admin 强制 viewer（`queue.ts:362-375`）；非 admin 队列排除竞赛提交（`:426-429`）；`getSubmissionQueueStatus` 非 owner 返回 null（`:660`） |
| **VULN-04/05** | **升级为 High（N-03）** | 见上表 |
| F-02 | 不重复上报；**影响面补充**：`affect_global_ranking` 只作用于 `solved_count`/`HAVING`/排序（`rankings.ts:249-258,355-370`），而 **`total_submissions`（COUNT(*) 全量）与 `acceptance_rate` 对竞赛提交完全不过滤** → 赛中以 username 实名轮询即可看到对手 `total_submissions` 递增（刚提交）与通过率抬升（刚通过），`rank` 同步变化 | — |

## 4. 已审但未发现问题的子面

| 子面 | 检索词 | 结论 |
|---|---|---|
| 手写时间窗口比较 | `rg "start_time\|end_time" --glob '!tests'` | 比较实现只在 `contest-window.ts`（`runningWindowCondition:92`、`unendedWindowCondition:122`）+ schema CHECK；**手写字典序比较 0 处**。但**调用口径**仍有 2 处漂移（`problem-exposure.ts:32-56`、`problems-stats.ts:257` = T-01） |
| 广播语义信道 | `broadcast\|notifyAll\|sendToAll\|全员\|全场\|所有参赛者` | 仅公告（admin）与答疑公开回复（主办方）；SSE 全集 6 个事件（`shared/sse/event-bus.ts:17-39`），**不存在"向全场推文本"的 SSE 信道** |
| 私信域竞赛门控 | `rg -c "contest\|isParticipant\|unended" messaging/**` | **0 命中**（1:1 私信无需竞赛门控；无群聊） |
| 匿名可读面盘点 | `rg -c "optionalAuthMiddleware" domains/*/routes/*.ts` | 34 处，逐一抽查（见矩阵） |
| 服务端强制项 | 提交上限 / rejudge / 迟到 / 赛前 / 封榜 | **全部服务端强制**（矩阵末 4 行 + `contest-ranking.ts:504-526`） |

## 5. 结论与处置建议（本轮**未做任何修复**）

**修复优先级（建议）**：**N-01**（Critical，两行改动即可封堵：diagnosis 讨论帖必须携带并落库 `problem_id`，或把写门控改为"正文所涉题目不可知即拒绝"）→ **N-03**（High，扩 `kind` 谓词）→ **N-02**（Medium，moderation 路径改用 SSOT）→ N-04/N-05/T-01（加固）。

**为什么本轮不修 N-01/N-03**：

- **N-01 的本质是内容政策决策**，不是普通缺陷：社区 `discussion`/`moment`/评论是通用功能，"赛中是否允许全场广播任意文本"只能由 Owner 决定（可选：赛期限制广播类发帖、要求讨论帖必须关联题目、或对赛期内容加审核队列）。Owner 已明确**反作弊系统的功能设计不在本轮范围**，而该修法正属此类。
- **N-03 要改保密 SSOT 的 `kind` 语义**（`problem-secrecy.ts:85-95` 的 `kind='public'`），会同时改变题库列表/搜索/主页/社区四类读路径对**邀请赛与私有赛**的可见性——属 spec §7 的"设计级变更 + 需改契约"，且影响面远超一个修复。
- 截止前余量不足以完成"7 处调用点 + 回归测试 + 门禁"，按 spec §7「拿不到 before/after 证据的 change 不进栈」，改为交付本报告与提案。

**未复核声明**：本面全部结论仅有**单方审计证据**（未派 verifier、Lead 亦未逐条读证）。按 L1 口径，
**N-01/N-02/N-03/N-04/N-05/T-01 均不得视为"已确认缺陷"**，只能作为"待复核候选"；其中 N-01 与 N-03
的建议优先复核——它们直接决定公开赛能否安全开赛。
