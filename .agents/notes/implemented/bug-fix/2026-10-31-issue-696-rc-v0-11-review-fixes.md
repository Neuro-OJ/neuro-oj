# Agent Note: Issue #696 rc/v0.11 评审问题修复

Status: implemented

## Problem

在 `rc/v0.11`（Issue #696）评审中发现 20 项问题，涵盖 CI 门禁、数据库迁移、权限边界、比赛与教学业务逻辑以及前端交互：

1. `dev-docs/engineering/route-catalog.md` 未随提交历史路由下线同步更新，导致 `gen-route-catalog.ts --check` 失败。
2. `0123_issue_696_notifications.sql`、`0122_issue_696_teaching.sql`、`0125_domain_training_publication_state.sql`、`0126_problem_owned_effective_policy.sql` 在收缩或加约束前缺少既有数据回填与清理，且 `trainings.state` 缺少 `('draft', 'published')` CHECK 约束。
3. `listAssignmentItemSubmissions` 在作业结束前将学生本人查看自己的证据提交一并拦截，且对非教职工未过滤未结束公开赛保护题。
4. `communityNotificationVisibleWhere` 未校验 `comment_id` 对应评论的发布状态；`EDITOR_PERMISSIONS` / `ADMIN_PERMISSIONS` 缺少 `training:delete_own` / `training:delete_any`。
5. 正式成绩榜单接口未透传 `classroom_id`，关联班级未过滤已归档班级，前端榜单缺少「全部参赛者」分组；域比赛详情页未挂载答疑面板且 `useContests` 答疑接口仍指向已退役旧路径。
6. 比赛题目详情页将 `ui` 题误归入内联作答、重复渲染「作答版本」横幅；`DomainContestAnswer` 传入冗余属性；`ProblemAnswerPanel` 客观题未展示选项字母且刷新后丢失已交卷锁定；`DomainHomeContent` 切换教学/学习视角未刷新；题单与题库进度展示缺少分数或状态区分；通知页缺少域工作区布局；`readDomainTraining` 与 `DomainProblemVersionSelect` 存在冗余请求。

## Decision

1. 重新生成 `dev-docs/engineering/route-catalog.md`。
2. 在 `0122`、`0123`、`0125`、`0126` 迁移中补齐旧表数据迁移、非学生角色清理、题单发布态回填与 `trainings_state_check` 约束、自有绑定有效版本策略回填，并在 `setDomainProblemBindingState` 中同步递增 `problems.effective_policy_revision`。
3. 在 `listAssignmentItemSubmissions` 中允许学生本人查看自己的提交并补充 `unendedPublicContestForProblem` 赛题保密条件；在 `communityNotificationVisibleWhere` 中校验关联评论状态；为 `editor` / `admin` / `educator` 补齐题单删除权限。
4. 在 `updateAssignment`、`copyAssignment`、`syncStudentAssignmentRecipients` 中修正历史提交计入与区间起点语义；在 `readDomainTraining` 中改为批量查询题目版本以消除 N+1。
5. 修复域比赛题目页、成绩榜、答疑面板、客观题作答面板、域首页教学卡片、题单与题库分数展示、域内通知页布局及版本选择器按需加载。

## Alternatives considered

- 仅在应用层兜底迁移前后的脏数据：无法防止非空数据库升级时外键或 CHECK 约束直接报错，因此在 SQL 迁移内显式完成回填与清理。
- 保持 `DomainProblemVersionSelect` 挂载即请求版本列表：在无需切换版本的常规题面浏览中会产生多余请求，改为在弹出层打开时按需加载。

## Consequences

- `gen-route-catalog.ts --check`、`check-migration-safety.ts`、`check-migration-snapshot-chain.ts` 与 `verify-agent-note-format.ts` 均通过。
- 非空数据库执行 `0122`–`0126` 迁移时不会丢失通知、题单发布状态或自有题目版本策略，也不会因遗留数据触发约束失败。
- 比赛、教学、社区通知与题单的前后端行为与权限边界保持一致。
