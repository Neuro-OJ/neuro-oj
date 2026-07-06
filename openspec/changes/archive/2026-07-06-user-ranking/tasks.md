## 1. 后端：新建 rankings service

- [ ] 1.1 新建 `noj-core/src/services/rankings.ts`，实现 `getGlobalRankings({ page, limit })` 和 `getMyRanking(userId)` 两个函数
- [ ] 1.2 复用 `users.ts:getUserProfile` L84-99 的 `count(*) filter (where ${evaluationResults.status} = 'Accepted')` 聚合写法
- [ ] 1.3 SQL 排除 `users.id = '0'`（root 系统用户），`HAVING` 限定只显示有通过记录的用户
- [ ] 1.4 排序键：solved_count DESC, acceptance_rate DESC, total_submissions ASC, u.created_at ASC

## 2. 后端：新建 rankings route + app.ts 挂载

- [ ] 2.1 新建 `noj-core/src/routes/rankings.ts`，导出 Hono 实例
- [ ] 2.2 `GET /` 公开访问，返回 `{ data, pagination }`（无 `authMiddleware`）
- [ ] 2.3 `GET /me` 需登录（显式 `authMiddleware`），返回单行 `RankingRow | null`
- [ ] 2.4 在 `noj-core/src/app.ts` 中新增 `app.route("/api/v1/rankings", rankings)` 挂载

## 3. 后端：扩展 user profile 响应

- [ ] 3.1 修改 `noj-core/src/routes/users.ts` 的 GET `/:id/profile` 处理函数
- [ ] 3.2 调用 `getMyRanking(userId)` 取 `rank` 字段，合并到响应对象
- [ ] 3.3 `rank` 类型：`number | null`（未上榜为 null）

## 4. 后端：单元测试

- [ ] 4.1 新建 `noj-core/tests/services/rankings_test.ts`，覆盖以下场景：
  - [ ] 4.1.1 `getGlobalRankings`：3 用户（A=5 solved, B=3 solved, C=0 solved），C 不出现在结果中
  - [ ] 4.1.2 排序稳定性：相同 solved_count 时按 acceptance_rate、total_submissions tiebreak
  - [ ] 4.1.3 排除 root 用户（id='0'）
  - [ ] 4.1.4 `getMyRanking`：已登录用户返回自己的 rank，未上榜用户返回 null
  - [ ] 4.1.5 分页：`page=2&limit=2` 返回正确切片与 pagination.total
- [ ] 4.2 新建 `noj-core/tests/routes/rankings_test.ts`（路由层），覆盖：
  - [ ] 4.2.1 `GET /api/v1/rankings` 无需 token，公开访问
  - [ ] 4.2.2 `GET /api/v1/rankings/me` 未登录返回 401
  - [ ] 4.2.3 `GET /api/v1/rankings?page=0` 返回 400（page 校验）

## 5. 前端：composable + types

- [ ] 5.1 新建 `noj-ui/composables/useRankings.ts`
- [ ] 5.2 定义 `RankingRow` 和 `RankingsResponse` 接口（与后端响应字段对齐）
- [ ] 5.3 封装 `useRankings(page, limit)` composable，返回 `{ data, pending, error, refresh }`

## 6. 前端：ranking 页面 + 导航 + 用户主页

- [ ] 6.1 新建 `noj-ui/pages/ranking.vue`，仿 `pages/users/[id].vue` 模板
- [ ] 6.2 表格列：排名 / 用户名 / 解题数 / 通过率 / 提交数
- [ ] 6.3 当前登录用户行高亮（`bg-primary/5`）
- [ ] 6.4 复用 `components/PaginationNav.vue` 分页
- [ ] 6.5 复用 `components/ui/AsyncContent.vue` 三态容器
- [ ] 6.6 空状态文案："还没有用户通过任何题目，做第一个吧 👉 /problems"
- [ ] 6.7 修改 `components/Navbar.vue`，在"提交记录"与"队列"之间插入榜单入口
- [ ] 6.8 修改 `pages/users/[id].vue`，在统计卡区域追加"排名"卡（仅当 `profile.rank !== null`）

## 7. 验证

- [ ] 7.1 `deno task test` 全部通过（含新 rankings 测试）
- [ ] 7.2 `deno task fmt --check` 无格式问题
- [ ] 7.3 `deno task lint` 无 lint 错误
- [ ] 7.4 `cd noj-ui && deno task dev`，访问 http://localhost:3000/ranking 看到表格渲染
- [ ] 7.5 登录后访问 `/users/{自己的id}`，看到排名卡显示正确 rank
- [ ] 7.6 `curl -s http://localhost:8000/api/v1/rankings` 返回正确排序的用户列表
- [ ] 7.7 `nuxt build` 成功（CI ui-check 通过）