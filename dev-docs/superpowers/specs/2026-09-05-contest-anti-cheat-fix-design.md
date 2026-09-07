# 竞赛防作弊修复设计（2026-09-05 审计整改）

> 日期：2026-09-05
> 关联审计：[dev-docs/audit/2026-09-05-noj-cheating-audit/summary.md](../audit/2026-09-05-noj-cheating-audit/summary.md)
> 状态：设计经 brainstorming 流程与需求方确认，待评审
> Scope: noj-core / noj-judge / noj-ui / noj-tests / noj-docs

## 1. 背景与目标

2026-09-05 完成《竞赛作弊面审计》，确认 15 项 finding（F-01..F-15）。威胁模型：单个普通登录用户、无合谋、无管理员/服务器权限，动机为排名与奖品；严重度 = 可利用性 × 排名优势 × 难度。

审计核心结论：

- 竞赛门禁只存在于竞赛路由（contest/routes/contests.ts），提交/自测/产物三个服务入口无竞赛上下文，普通路由可绕行（F-05）；
- problems 表无可见性字段，type=U 题匿名可读全字段（含 support_package_storage_url / runtime_config / llm_config）（F-03）；
- 客观题练习提交路径可拿到整卷 expected 答案（F-01，最高危，与旧审计 NOJ-012 同根）；
- SSE 事件与公开提交详情击穿运行中竞赛隔离（F-02）；评测队列 2 槽 FIFO 可被饥饿（F-07）。

本设计目标：

1. 引入洛谷式题目可见性模型（private/public）与竞赛分类（public/invite）；
2. 把访问与提交强制下沉到服务层统一解析器，杜绝路由旁路；
3. 统一提交结果投影：赛时参赛者只见 score+status，hidden 判据任何时刻不可见；
4. 评测公平：每用户并发上限 1；
5. 硬化与运营：流式解压、注册验证开关、竞赛注册限流、运营后台（题目评定队列）。

## 2. 范围决策（已确认）

以下决策均经 brainstorming 逐项确认，作为本 spec 的不可变输入：

| 决策点 | 结论 |
| --- | --- |
| 范围 | 15 项一次定稿：本轮修复 12 项（F-01/02/03/04/05/07/08/11/12/13/14/15），F-06/F-09/F-10 搁置（rate limit 议题，后续专项） |
| 题目可见性 | problems 新增 visibility ∈ {public, private}；存量全部置 public 保现状；新建 U 默认 private，P 恒 public |
| private 题访问 | 仅 owner/admin 可读可提交；赛时经竞赛上下文对参赛者开放；无权限一律 404（读路径） |
| 题目-竞赛关系 | 不做反向链接/自动锁；赛前保密靠出题人自觉，管理员处罚威慑；不新增用户操作审计日志 |
| 被竞赛引用禁删 | 删除被任何竞赛引用的题目时拒绝 |
| 赛后可见性 | private 题赛后经竞赛页对参赛者仍可见（复盘）；普通路径 404 直到 owner 转 public |
| U 转公开 | owner 手动转 public（公开个人题）；不进主列表（列表保持 P-only）；经 owner 主页/题单/搜索可达 |
| U 转 P | 必须管理员手动操作（problem:create_p） |
| 竞赛分类 | contests.kind ∈ {public, invite}；邀请赛列表不可见，需链接+邀请码；公开赛列表可见、任何人均可加入（无码时自助注册） |
| 密码语义 | password 列复用为邀请码：invite 必须非空；public 可设可不设，仅管理员增删（不强制移除） |
| 建赛权限 | 普通用户可建 invite（新 RBAC contest:create）；公开赛仅管理员可建 |
| 邀请赛提公开 | 用户线下找管理员（邮件/私信）沟通，管理员在管理接口手动翻转 kind；无后台审批流 |
| 建赛加题限制 | 普通用户仅可加 public 题或自己 owner 的题入赛；管理员不限（堵“造竞赛上下文套他人私有题”洞） |
| 提交强制模型 | 方案 A：服务层统一 resolver；私有题非 owner/admin 且无竞赛上下文 → 提交入口 403；带上下文 → 校验成员+窗口+套竞赛限额 |
| 客观题/题单 | resolver 覆盖套卷读题与练习提交；题单加题须 public 或自有 |
| 结果投影 | 赛中参赛者只见 score+status；visible 用例数据赛时赛后均可见；hidden input/expected 任何时刻不进用户可见范围（owner/admin 除外）；赛后恢复 score+status |
| 全局队列 | 竞赛提交对普通用户不显示（管理员可见）；竞赛页不做独立评测队列视图 |
| 客观题解析 | paper 转 public 后练习提交可带 explanation/expected 解析 |
| F-04 限额 | Redis 原子预算（INCR+TTL 至 end_time）+ DB 对账 |
| F-07 公平 | 每用户并发上限 1，全局不限制（移除 Semaphore(2)） |
| F-12 邮箱验证 | 新增开关，默认 off，运营手动开启 |
| 搁置项 | F-06（LLM 预算：无 AC 语义）、F-09（BYOK 预算）、F-10（网关分桶）：rate limit 议题，后续专项 |

## 3. 修复机制与 finding 映射

15 项 finding 不逐条零散修，归入 5 条横切机制：

| 机制 | 吸收 finding | 关键组件 |
| --- | --- | --- |
| ① 数据模型 | F-03（基础） | problems.visibility、contests.kind |
| ② 访问解析器 + 提交上下文 | F-05、F-04、F-01（根因） | resolveProblemAccess、assertContestProblemAddable |
| ③ 统一结果投影 | F-01、F-02、F-14、F-15、F-11 | applySubmissionProjection、details 白名单 |
| ④ 评测公平 | F-07 | per-user 并发计数 |
| ⑤ 硬化与运营 | F-08、F-12、F-13、运营后台 | 流式解压、邮箱验证、注册限流 |

## 4. 数据模型（机制①）

沿用现有约定：text 主键、ISO 8601 文本时间戳、Drizzle ORM。

### 4.1 problems 新增 visibility

| 列 | 类型 | 说明 |
| --- | --- | --- |
| visibility | text notNull default 'public' | 'public' / 'private'，CHECK 约束 |

- CHECK (visibility IN ('public','private'))；
- CHECK (type='P' → visibility='public')：主题库题必须公开；
- 应用层：新建 U 默认 private，新建 P 恒 public（DB 默认 public 作安全兜底）；
- 迁移：存量行一律置 public，保住现状访问。

### 4.2 contests 新增 kind

| 列 | 类型 | 说明 |
| --- | --- | --- |
| kind | text notNull | 'public' / 'invite'，CHECK 约束 |

- 迁移：kind = is_public ? 'public' : 'invite'；is_public 列保留弃用（老客户端兼容），新代码只读 kind；
- password 列复用为邀请码：invite 必须非空（create/update 服务端校验）；public 可设可不设；
- 存量 kind=invite 且 password 为空/缺失的行，迁移生成随机邀请码；
- 竞赛状态仍由 start_time/end_time 动态计算，不新增状态列。

### 4.3 题目可见性访问矩阵

| 访问者 | private | public |
| --- | --- | --- |
| 匿名 | 404 | 可读（U 不进主列表；P 进主列表） |
| 登录（非 owner） | 404 | 可读可提交 |
| owner | 可读可提交 | 同 |
| admin | 可读可提交 | 同 |
| 竞赛参赛者（经竞赛上下文，赛中及赛后） | 可读题面+提交；结果按 §6 投影 | 同 |

### 4.4 竞赛 kind 行为矩阵

| 行为 | public | invite |
| --- | --- | --- |
| 竞赛列表可见 | 是 | 否（链接 + 邀请码直达） |
| 注册 | 无码自助；有码需密码 | 必须邀请码 |
| 创建者 | 仅管理员 | 登录用户（contest:create） |

## 5. 统一访问解析器与提交上下文（机制②）

### 5.1 resolveProblemAccess

位置：catalog 域服务，经域门面（index.ts）导出，供 submission/objective/contest 使用；shared 不反向依赖 domains。

判定顺序（fail-closed，默认拒绝）：

1. isAdmin → allowed；
2. viewerId === owner_id → allowed（owner 对 private 保有提交 solution 能力）；
3. 无 contestId → 仅 visibility=public 放行；
4. 带 contestId → 题目在该竞赛 problemIds 内 ∧ viewer ∈ contest_participants ∧（窗口内 OR 赛后）→ allowed(contest)。

- 赛中与赛后均放行（赛后复盘）；赛前拒绝；
- contestId 存在但竞赛不存在 → 按无上下文处理（public 规则），绝不放行；
- 读路径无权限一律 404（防存在性探测）；提交入口无权限 403（提交需要已知题目 id，语义为“无权对该题提交”）。

### 5.2 读路径改造

| 入口 | 现鉴权 | 新规则 |
| --- | --- | --- |
| GET /problems/:id | 无 owner 限制 | resolver 前置；非 owner/admin 字段分级投影（剥 support_package_storage_url / runtime_config / llm_config） |
| GET /problems 列表 | P-only | 保持 P-only；过滤条件改为 visibility=public 且 type='P' |
| GET /contests/:id/problems/:label | 赛时参赛者 | 显式传 contest 上下文 → resolver 放行（不看 visibility） |
| GET /problems/:id/questions（套卷） | 匿名可读 | resolver 前置；竞赛 UI 改走竞赛上下文，不再绕过 requireContestAccess |
| 题单详情题目列表 / 搜索 | 无逐题过滤 | 仅 public 题可见；搜索 WHERE 增加 visibility=public |
| 支持包下载 | owner/admin | 保持 owner/admin；任何 contest 上下文不放行；详情不再下发 storage_url 给非 owner/admin |
| 题单加题 | 无归属校验 | 仅 public 或自己 owner 的题（与建赛加题同规则） |

### 5.3 提交路径改造（方案 A）

三个服务入口 createSubmission / artifact createSubmission / self-test：

- 统一增加 contestCtx? 参数，校验全部在服务层（路由仅解析上下文）；
- POST /contests/:id/submit → contestCtx={contestId}：成员+运行中窗口+限额校验后插入，submission 写 contest_id；竞赛提交仅窗口内（running）允许，赛后经竞赛页仅可读/复盘、不可再提交；
- 普通 POST /submissions、self-test → 无 contestCtx：resolver 判定 private 非 owner/admin → ForbiddenError（参赛者经普通入口提交私有题同样 403，必须走竞赛入口）；
- 服务层是唯一强制点，杜绝“换条路由绕过”。

### 5.4 加题侧限制（堵套题洞）

assertProblemsExist → assertContestProblemAddable（createContest / updateContest 调用点）：

- admin 不限；
- 普通用户：仅 visibility=public 或 owner_id=创建者 的题可入赛；
- trainings addTrainingProblem 同规则。

### 5.5 F-04 提交限额（Redis 原子预算）

- 键：contest:lim:{contestId}:u:{userId}（及每题维度 contest:lim:{contestId}:u:{userId}:p:{problemId}）；
- 提交前 INCR + EXPIRE(截止 end_time)，超 submission_limits → 429；
- DB 计数保留供管理展示与对账；artifact 上传入口同规则。

## 6. 统一结果投影（机制③）

### 6.1 applySubmissionProjection

单一纯函数，所有读路径强制复用：提交详情、我的提交列表、竞赛提交列表、SSE 事件、全局队列、客观题提交响应。杜绝“这条路径忘了裁剪”式旁路（F-02/F-14/F-15 的共同根因）。

输入 (submission, { viewerId, isAdmin, contestStatus, isParticipant })，输出档位：

| 档位 | 可见内容 |
| --- | --- |
| 提交者本人 / 题目 owner / admin | 全量（含 details/判据） |
| 竞赛运行中 + 参赛者本人 | status + score；剥离 details 判据/testCases/subtasks；visible 用例数据可见，hidden 不可见 |
| 赛后 + 参赛者本人 | score+status 恢复；visible 可见；hidden 仍不可见 |
| 他人（非竞赛 public 题练习提交） | 维持现状（public 提交公开） |
| 竞赛运行中 + 他人 | 不可见（仅“存在”级信息） |

- evaluate.py 输出契约新增每条用例 hidden 标记（脚本本就区分 visible.jsonl/hidden.jsonl，标记天然可得）；旧脚本无标记 → 竞赛上下文下一律剥离逐用例细节（fail-safe）；
- details 白名单化（F-11）：核心侧对 judge 返回的 details 做 key 白名单 + 大小上限，超出丢弃；
- SSE 与 REST 共用同一投影函数，保证渠道一致。

### 6.2 F-01 / F-14 客观题

- 写入侧根治（F-14）：objective-submissions 插入时剥离 expected 类字段后再入库（judgement.details 裁剪），入库不含判据则任何后续路径不可能泄；
- 读取侧（F-01）：练习提交 withExplanation 仅 paper visibility=public 或 viewer 为 owner/admin 时返回；private paper 练习提交一律不带解析；
- 竞赛客观题提交走 §6.1 投影：赛中参赛者只见自己得分与对错状态，不见 expected。

### 6.3 F-02 / F-15 SSE 与队列

- GET /submissions/:id：optionalAuth 保留，但响应强制过投影（匿名按匿名档处理）；
- SSE contestSubmission 频道：订阅校验用户为竞赛成员，非成员不推送；推送内容过投影；
- 全局队列对普通用户隐藏竞赛提交条目；管理员可见全部；竞赛页不做独立评测队列视图。

## 7. 评测公平（机制④）

- 移除全局 Semaphore(2)；新增每用户并发上限 1（per-user active 计数，judge 内存态）；
- 取任务顺序：跳过已有活跃评测的用户，其余按入队序取（FIFO）；
- 全局不限：瞬时容器数由 Docker 资源约束，部署需知悉；
- core 侧既有限流保留（提交 120/min、self-test 60s/4）。

## 8. 硬化与运营（机制⑤）

### 8.1 F-08 judge 内存硬化

- 支持包下载/解压流式落盘，消除整包 RAM 驻留与 to_vec 双份拷贝；
- 30s deadline 从注入开始计时（注入+评测共用绝对时限）；
- 既有 1000 条目 / 64MiB 单文件 / 512MiB 总解压上限不动。

### 8.2 F-12 注册邮箱验证

- 新开关 REGISTER_EMAIL_VERIFY（默认 off，运营手动开启）；
- 开启后注册需邮箱验证码，复用现有 email provider 策略。

### 8.3 F-13 竞赛注册限流

- POST /contests/:id/register 增加 Redis 限流：per IP+contest（30s/5）+ 失败退避（同登录限流模式）；
- 邀请码错误计数受限。

### 8.4 运营后台（noj-ui + noj-core admin 路由）

- 题目评定队列：待转公开 / 待转 P 两个列表 + 批量操作；
- owner“我的题目”页一键转 public；
- 管理员：U→P 转换（problem:create_p）、kind 翻转（invite→public，线下沟通后手动）、邀请码重置；
- 建赛向导（普通用户）：kind=invite 默认；选自己 owner 题或 public 题（前端提示 + 后端校验兜底）；public 按钮对非管理员禁用并提示联系管理员。

## 9. API 变更汇总

| 变更 | 端点 | 说明 |
| --- | --- | --- |
| 读题门禁 | GET /problems/:id 等 | resolver + 404 + 字段分级 |
| 加题校验 | POST/PUT contests、trainings/:id/problems | assertContestProblemAddable |
| 提交上下文 | POST /submissions、self-tests、artifact | 服务层 contestCtx 参数 |
| 投影 | GET /submissions/:id、SSE、全局队列 | applySubmissionProjection |
| 建赛 | 新增普通用户 POST /contests | contest:create，kind=invite |
| 注册 | POST /contests/:id/register | kind 语义 + 限流 |
| 后台 | admin 路由新增：题目评定队列、kind 翻转、邀请码重置 | - |
| 题目更新 | PUT /problems/:id | 增加 visibility setter（owner 转 public；admin 任意） |

## 10. RBAC 变更

- 新增 contest:create（默认角色授予，seed 幂等）；
- 复用 problem:create_p（U→P 转换）、problem:write_own（owner 转 public）；
- ensureRbacSeeds 增加新权限种子。

## 11. 迁移计划

- problems.visibility（存量置 public）；
- contests.kind（is_public 映射；invite 空密码补随机码）；
- deno task db:generate 生成迁移；不手改 _journal.json；新迁移不带 schema 前缀（分片测试约束）。

## 12. 测试计划

- noj-core：resolver/投影单测矩阵（角色 × 可见性 × 窗口 × 4 域入口）；deno task test:parallel；
- noj-judge：公平取任务 / 流式解压；cargo nextest run --all-targets；
- noj-tests e2e 攻击剧本：
  1. 无上下文直取私有题 → 404；
  2. 伪造 contestId → 拒绝；
  3. 竞赛入口重复提交超 submission_limits → 429；普通入口对私有题 → 403；
  4. 他人私有题加入自己竞赛/题单 → 拒绝；
  5. 非参赛者订阅 SSE → 无事件；
  6. 赛中提交详情/全局队列不泄判据；
  7. 客观题练习提交不泄 expected（private paper）。
- noj-docs：出题人指南（visible/hidden 标记、evaluate.py 契约、不印 hidden 细节）、安全模型文档同步。

## 13. 搁置项与残余风险

| 项 | 状态 | 理由 |
| --- | --- | --- |
| F-06 LLM 预算 | 搁置 | 无 AC 语义；rate limit 议题，后续专项 |
| F-09 BYOK 预算 | 搁置 | rate limit 议题；挂起评测只锁自己槽位（每用户独立），不影响他人 |
| F-10 网关分桶 | 搁置 | 随 F-06 专项 |

残余风险（已接受）：

- 赛前保密靠出题人自觉（无反向锁），威慑机制为管理员处罚；
- BYOK 无超时：恶意用户可挂死自己唯一并发槽（仅影响本人）；
- 公开 U 题不进主列表，发现依赖 owner 主页/题单/搜索；
- 邀请赛链接+邀请码站外泄露无法技术阻止（合谋/社攻不在威胁模型内）。

## 14. 文档同步

- noj-docs 安全模型、出题人指南；
- noj-core/CLAUDE.md 提及 visibility/kind 新列；
- 实施时新增 .agents/notes/implemented/ 记录（architecture 分类）。
