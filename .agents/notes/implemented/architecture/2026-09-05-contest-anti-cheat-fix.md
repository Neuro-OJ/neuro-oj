# Agent Note: 竞赛防作弊修复（题目可见性 / 提交结果投影 / 竞赛分类）

Status: implemented

## Problem

2026-09-05 审计整改中发现多条与竞赛防作弊相关的信息泄露与公平性风险：题目只有公开/私有两种直觉语义但缺少统一访问判定；竞赛上下文可被随意携带，存在借他人私有题构造竞赛上下文绕过访问控制的路径；提交结果详情可能把隐藏用例、标准答案、判据、原始输出通过 REST/SSE/队列等渠道泄露；竞赛缺少 `public`/`invite` 的分类模型，邀请校验、创建权限与公开列表语义混用；评测机器侧旧的有全局 Semaphore 槽位闸门会让单个用户挤占全局评测资源，缺少按用户公平调度。

## Decision

- 数据模型新增 `problems.visibility`（`public`/`private`，默认 public）与 `contests.kind`（`public`/`invite`，默认 public），均带数据库 CHECK 约束；旧 `contests.is_public` 保留用于列表/详情展示，`kind` 负责创建权限与报名/邀请语义。
- catalog 域新增纯函数 `resolveProblemAccess`，统一读取与提交路径的题目访问判定：admin → owner → 竞赛上下文（不回退 public）→ visibility；竞赛上下文由 contest 域的 `verifyContestAccess`（题目归属 + 参赛者 + running/ended）产出，域间通过轻量 `ContestAccessInfo` 传入。
- submission 域新增 `applySubmissionProjection`（F-02/F-15），所有提交详情/列表/SSE/队列读路径强制复用：竞赛中参赛者本人保留状态与分数但剥离隐藏用例、subtasks/testCases/output；赛后隐藏用例仍不返回；非本人/非参赛者仅返回存在级信息；旧脚本 `details.cases` 缺少 `hidden` 标记时 fail-safe 全剥。
- judge 结果落库前增加 `sanitizeJudgeDetails` 白名单化（F-11），仅放行安全键并限制单值 64KB；评测脚本契约更新为每个用例必须输出布尔 `hidden` 标记，隐藏用例不得输出输入/期望/实际输出。
- judge 侧移除全局 Semaphore 槽位闸门（F-07），改为 `active_users` 集合实现每用户并发上限 1，活跃用户的新任务放回队尾，避免单用户占满评测资源。
- 竞赛注册按 `kind` 语义校验：`public` 可自助注册（可设密码），`invite` 必须提供邀请码；普通用户默认只能创建 `invite`，`public` 仅管理员可创建；同时增加注册/提交限流（F-04/F-13）。
- 客观题同样防泄露：入库前剥离 `expected`，竞赛模式不返回解析与标准答案（F-01/F-14）。
- 文档同步：安全模型、出题指南、`noj-core/CLAUDE.md` 速查表已更新，内置样例题 `evaluate.py` 已按新契约输出 `hidden`。

## Review fixes（2026-09-05 代码评审后补充）

- 客观题练习提交封堵：`submitObjectivePaper` 增加 `isAdmin` 参数，非 owner/admin 对 private 套卷练习提交返回 403；路由透传 `submission:read_all`。
- 邀请码迁移缺陷修复：`isBcryptHash` 兼容历史明文邀请码，移除会清空明文邀请码的 SQL 回填。
- 竞赛题目页取题请求追加 `?contest_id=`，避免 private 套卷在竞赛页 404。
- 创建/更新竞赛时 `is_public` 与 `kind` 绑定（public ↔ true，invite ↔ false）。
- F-12 改为 fail-closed：`register_email_verify=true` 时注册直接拒绝，不再接受任意 `email_code`；补充路由失败路径测试。
- U 型新建默认 private、P 型恒 public：新增 `problems_p_visibility_check` CHECK 约束与迁移 `0065`。
- SSE `contest:submission:created` 仅参赛者/管理员订阅与重放。
- 域边界收敛：`catalog/routes/problems.ts` 不再直接依赖 contest 域；竞赛上下文校验收敛到 objective 域 `listPaperQuestionsWithAccess`，保持 catalog 不依赖 contest。
- F-14 响应侧：练习提交响应（含 owner/admin）统一剥离 `expected`，仅保留 correct/given/explanation。

## Alternatives considered

- 只在路由层逐个加权限判断：入口多、容易遗漏，无法形成“读+提交+竞赛”统一防线，后续路径改动仍可能绕过。
- 用 `visibility` 字符串代替 `hidden` 布尔作为投影依据：旧脚本字段语义不清，且无法区分“未标记”与“明确可见”，fail-safe 不够明确；最终以布尔 `hidden` 作为唯一判定依据并保留 `visibility` 兼容。
- 在竞赛上下文里允许 public 题回退访问：会让“伪造竞赛上下文”仍有可利用空间；决定不回退，竞赛上下文必须独立校验通过才放行。
- 继续使用全局 Semaphore 限制评测并发：无法保证单用户公平性，超大提交者会阻塞其他用户；改为每用户上限 1 更符合竞赛公平目标。
- 仅更新文档不更新样例/投影契约：文档与实现会漂移；本次同时更新 `evaluate.py` 和出题指南，使新脚本可被投影正确识别。

## Consequences

- `resolveProblemAccess` 成为题目访问的唯一判定入口，后续新读/提交路径必须复用，禁止在 service 里另写 visibility 判断。
- `applySubmissionProjection` 成为竞赛结果输出的唯一裁剪入口，任何新读路径必须接入，否则隐藏用例可能重新泄露。
- 旧评测脚本如果没有 `hidden` 标记，在竞赛详情中会整份隐藏用例详情（fail-safe），这是有意的行为变化；出题人需要按新契约更新 evaluate.py。
- `contests.kind` 与 `is_public` 语义分离：新建/编辑竞赛时需明确二者；invite 赛必须设置邀请码，普通用户可创建 invite，公开赛仅管理员可创建。
- judge 调度改为 per-user 限流后，同一用户的多个任务会串行排队，整体评测吞吐可能受单用户任务影响，但公平性优先。
- Task 19 同步了安全文档、出题指南与 CLAUDE.md；正式比赛题目仍不得提交到 `noj-core/data/problems-src/`，隐藏数据应通过受控存储部署。
