## 1. Schema & Database Migration

- [x] 1.1 在 `src/db/schema.ts` 新增 `contests` 表定义（含 check 约束和索引）
- [x] 1.2 在 `src/db/schema.ts` 新增 `contest_problems` 表定义（含复合主键和唯一约束）
- [x] 1.3 在 `src/db/schema.ts` 新增 `contest_participants` 表定义
- [x] 1.4 在 `src/db/schema.ts` 新增 `contest_clarifications` 表定义
- [x] 1.5 在 `submissions` 表新增 `contest_id TEXT REFERENCES contests(id) ON DELETE SET NULL` 列
- [x] 1.6 新增索引：`idx_submissions_contest_id`、`idx_submissions_contest_problem_user`、`idx_contests_created_by`、`idx_contests_start_time`、`idx_contests_end_time`、`idx_contest_participants_user`
- [x] 1.7 运行 `deno task db:generate` 生成迁移文件
- [x] 1.8 验证迁移：`deno task migrate` 成功执行

## 2. Types & Permissions

- [x] 2.1 创建 `src/types/contests.ts`：ContestType 常量 + 验证函数 + CreateContestInput / UpdateContestInput / ContestResponse / ContestProblemInput / ContestProblemResponse / IcpcRankingRow / IoiRankingRow 接口
- [x] 2.2 在 `src/types/index.ts` 的 `PERMISSION_DEFS` 中新增 contest:create、contest:manage、contest:participate
- [x] 2.3 在 `src/services/seed-rbac.ts` 中确保 3 个新权限被幂等初始化

## 3. Contest CRUD Service

- [x] 3.1 创建 `src/services/contests.ts`：`createContest(input, userId)` — 事务中同时创建竞赛 + 批量绑定题目
- [x] 3.2 `updateContest(id, input, userId)` — 修改竞赛字段 + DELETE/INSERT 题目绑定
- [x] 3.3 `deleteContest(id)` — 级联清理（依赖 DB CASCADE + SET NULL）
- [x] 3.4 `getContest(id)` — 单竞赛详情，含动态 status 计算、题目数、参与人数
- [x] 3.5 `listContests(params)` — 分页列表，支持 type 筛选、showAll（admin 看非公开）
- [x] 3.6 `registerForContest(contestId, userId, password?)` — 校验 is_public/password/status
- [x] 3.7 `addParticipants(contestId, userIds)` — 管理员批量添加
- [x] 3.8 `removeParticipant(contestId, userId)` — 管理员移除
- [x] 3.9 `listParticipants(contestId)` — 参与者列表
- [x] 3.10 `isParticipant(contestId, userId)` — 布尔判断
- [x] 3.11 `getContestProblems(contestId, userId?)` — 竞赛题目列表，含用户求解状态
- [x] 3.12 辅助函数：`computeContestStatus(startTime, endTime)` — 动态状态计算

## 4. Contest Ranking Service

- [x] 4.1 创建 `src/services/contest-ranking.ts`：`getIcpcRanking(contestId)` — ICPC 罚时排名 SQL
- [x] 4.2 `getIoiRanking(contestId)` — IOI/OI 总分排名 SQL
- [x] 4.3 `getContestRanking(contestId, type, isAdmin?, viewerId?)` — 统一入口，含封榜逻辑、OI 隐藏排名逻辑

## 5. Routes — Public

- [x] 5.1 创建 `src/routes/contests.ts`：`GET /` 竞赛列表（分页，公开）
- [x] 5.2 `GET /:id` 竞赛详情（含 is_registered 判断）
- [x] 5.3 `POST /:id/register` 注册参赛（authMiddleware + 密码校验）
- [x] 5.4 `GET /:id/problems` 题目列表（authMiddleware + 参赛校验 + 非 pending 校验）
- [x] 5.5 `GET /:id/problems/:label` 单题详情
- [x] 5.6 `GET /:id/ranking` 排名（OI 模式权限控制）
- [x] 5.7 `POST /:id/submit` 竞赛提交（authMiddleware + 参赛 + running 校验）
- [x] 5.8 `GET /:id/my-submissions` 我的竞赛提交
- [x] 5.9 在 `src/app.ts` 注册：`app.route("/api/v1/contests", contests)`

## 6. Routes — Admin

- [x] 6.1 在 `src/routes/admin.ts` 追加竞赛管理路由组
- [x] 6.2 `GET /admin/contests` — 全部竞赛列表（含非公开）
- [x] 6.3 `POST /admin/contests` — 创建竞赛
- [x] 6.4 `PUT /admin/contests/:id` — 编辑竞赛
- [x] 6.5 `DELETE /admin/contests/:id` — 删除竞赛
- [x] 6.6 `GET /admin/contests/:id/participants` — 参与者列表
- [x] 6.7 `POST /admin/contests/:id/participants` — 批量添加参与者
- [x] 6.8 `DELETE /admin/contests/:id/participants/:userId` — 移除参与者
- [x] 6.9 `GET /admin/contests/:id/submissions` — 竞赛全部提交

## 7. Submission Integration

- [x] 7.1 扩展 `src/services/submissions-crud.ts` 的 `createSubmission(userId, input, contestId?)` 支持可选 contest_id 参数
- [x] 7.2 扩展 `src/types/index.ts` 的 `SubmissionInput` 类型，新增可选 `contest_id` 字段
- [x] 7.3 竞赛提交成功时发布 `Channels.contestSubmission(contestId)` 事件

## 8. Event Bus & SSE

- [x] 8.1 在 `src/lib/event-bus.ts` 的 `Channels` 中新增 `contestRanking(id)` 和 `contestSubmission(id)`
- [x] 8.2 扩展 SSE 路由：`GET /api/v1/contests/:id/events`（复用 streamSSE 模式）
- [x] 8.3 在 `src/services/submissions-result.ts` 的评测结果持久化后，检查 `contest_id` 并发布 `Channels.contestRanking` 事件
- [x] 8.4 排名推送限流：≥ 5s 间隔

## 9. Tests — Backend

- [x] 9.1 创建 `tests/services/contests.test.ts`：CRUD + 参赛 + 边界条件
- [x] 9.2 创建 `tests/services/contest-ranking.test.ts`：ICPC 排名正确性（含罚时/封榜边缘情况）+ IOI 排名正确性
- [x] 9.3 创建 `tests/routes/contests.test.ts`：公开路由 + 管理路由集成测试
- [x] 9.4 扩展现有提交测试：验证 `contest_id` 字段正确写入和查询

## 10. Frontend (Phase 3)

- [ ] 10.1 竞赛大厅页面 `/contests`：竞赛卡片列表 + 分页 + 类型/状态筛选
- [ ] 10.2 竞赛详情页 `/contests/:id`：倒计时 + 题目列表 + 排名入口 + 提交入口
- [ ] 10.3 竞赛做题页 `/contests/:id/problems/:label`：复用 MonacoEditor + ProblemEditor 组件，API 走竞赛端点
- [ ] 10.4 竞赛排名页 `/contests/:id/ranking`：ICPC 表格（solved/penalty）+ IOI 表格（total_score）
- [ ] 10.5 管理后台：竞赛列表 + 创建/编辑竞赛表单 + 参与者管理
- [ ] 10.6 管理后台：竞赛题目选择器（从现有题库搜索/选择）

## 11. E2E Tests (Phase 3)

- [ ] 11.1 创建 `noj-tests/e2e/22_contest_lifecycle.test.ts`：创建竞赛 → 注册 → 提交 → 排名 → 封榜 → 结束
