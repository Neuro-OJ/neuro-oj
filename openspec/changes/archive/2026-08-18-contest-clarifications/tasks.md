## 1. 数据层与通知基建

- [x] 1.1 `deno task db:generate` 生成迁移：`community_notifications` type CHECK 扩展为含 `'clarification'`；`contest_clarifications` 新增 `(contest_id, created_at)` 索引；同步更新 `schema.ts` 的 type 联合类型与 CHECK 定义
- [x] 1.2 导出 `createNotification`（从 `services/community.ts` 提取为 `services/notifications.ts` 公共服务或直接导出），type 联合类型扩展 `'clarification'`，调用方（community.ts 内部）迁移到新位置
- [x] 1.3 `deno task test` 确认既有 community 通知单测与迁移测试通过（无回归）

## 2. 后端 API

- [x] 2.1 新建 `src/services/contest-clarifications.ts`：`createClarification`（参赛者校验、竞赛 running 校验、`problem_id` 归属校验、内容校验）
- [x] 2.2 同文件实现 `replyToClarification`（admin/创建者判定 `isUserAdmin || created_by`、目标为根提问校验、回复写入、调用通知服务）
- [x] 2.3 同文件实现 `listClarifications`（可见性过滤：匿名/未参赛仅公开、参赛者公开+自己的、主办方全部；线程组装：提问+回复、`problem_label` 映射；分页基于提问数）
- [x] 2.4 `routes/contests.ts` 挂载三个端点（`GET/POST /:id/clarifications`、`POST /:id/clarifications/:clarId/reply`），复用 `optionalAuthMiddleware` / `authMiddleware` 与既有错误处理
- [x] 2.5 `deno fmt` + `deno lint` + `deno task test` 通过（rebase 到 main 后重跑：714 passed | 0 failed）

## 2.6 Review 修订（PR #236 评审意见）

- [x] 2.6.1 spec 修订：匿名提问拆分 401（原 spec 笼统写 403，实现为 authMiddleware 401），补充"匿名提问被拒"scenario
- [x] 2.6.2 spec 补充：私有竞赛答疑列表 404 门禁说明 + scenario（与 `GET /:id` 门禁一致）
- [x] 2.6.3 迁移文件 `0037_parallel_gwen_stacy.sql` 补末尾换行（rebase 重编号后）
- [x] 2.6.4 E2E 补充 pending / ended 竞赛提问 403 断言（`28_clarifications.test.ts` 测试 3）
- [x] 2.6.5 `ClarificationsPanel.vue` 回复草稿按提问独立维护（切换提问不丢失）
- [x] 2.6.6 不采纳：`findContestRow` 复用 `getContest`（返回 DTO 含聚合字段，语义不同；contests.ts 无同名函数），review 已回复理由

## 3. 后端测试

- [x] 3.1 core 单测（`tests/services/` 或 `tests/routes/`，PGlite）：参赛者/非参赛者/匿名提问与可见性、running 时间窗口、`problem_id` 归属、回复权限（admin/创建者/普通用户）、回复的回复被拒、通知产生与"自己回复自己不通知"
- [x] 3.2 迁移测试：新迁移可应用（含 CHECK 扩展后插入 `clarification` 类型通知成功）

## 4. 前端 UI

- [x] 4.1 重构 `pages/contests/[contestId]/index.vue` 为 `UTabs`（详情/题目/答疑/排名），tab 同步 `?tab=` query；抽 `components/feature/contest/ContestRanking.vue`（排名内容从 `ranking.vue` 迁入，页面保留为薄壳）
- [x] 4.2 新增 `components/feature/contest/ClarificationsPanel.vue`：提问表单（running + 已参赛显示，题目下拉=全局+竞赛题目）、线程列表（公开/私密标记、缩进）、主办方回复表单（公开/私密单选）、`notification:new` 时静默刷新
- [x] 4.3 `composables/useContests.ts` 增加答疑 API 封装；`pages/community/notifications.vue` 增加 `clarification` 类型渲染与跳转（`/contests/{contest_id}?tab=clarifications`）
- [x] 4.4 `deno lint` + `deno fmt` + `nuxt build` 通过

## 5. E2E 与收尾

- [x] 5.1 新增 `noj-tests/e2e/28_clarifications.test.ts`（复用 helper）：参赛者提问→主办方公开/私密回复→提问者 `/community/notifications` 收到 `clarification` 通知；非参赛者提问 403、仅见公开；私密回复仅提问者与主办方可见；赛前/赛后提问被拒
- [x] 5.2 全量验证：`deno task test`（core）+ noj-tests E2E 全绿；`deno fmt` / `deno lint` 无警告
- [x] 5.3 提交：GPG 签名 + 中文 Conventional Commits（scope `core,ui,root` 按实际涉及）
