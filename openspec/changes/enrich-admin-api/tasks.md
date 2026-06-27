## 1. 重构管理路由组织结构

- [x] 1.1 创建 `routes/admin.ts`，使用路由组级 `authMiddleware` + `adminMiddleware` 中间件，将现有 adminAuth（用户列表/角色管理）路由迁移到 admin.ts
- [x] 1.2 将现有 adminSubmissions（提交列表）路由从 `routes/submissions.ts` 迁移到 `routes/admin.ts`
- [x] 1.3 更新 `app.ts` 中的路由挂载：移除 `adminAuth` 和 `adminSubmissions` 的单独挂载，统一改为 `app.route("/api/v1/admin", admin)`
- [x] 1.4 更新 `routes/auth.ts` 和 `routes/submissions.ts`，删除已迁移的 admin 相关导出

## 2. 实现仪表盘统计数据 API

- [x] 2.1 创建 `services/dashboard.ts`，实现 `getDashboardStats()` 服务函数：执行 4 次独立查询聚合用户数、题目数、提交数、24h 统计数据
- [x] 2.2 在 `routes/admin.ts` 中添加 `GET /dashboard/stats` 路由，调用 dashboard 服务返回统计 JSON

## 3. 增强管理员用户列表支持搜索筛选

- [x] 3.1 修改 `services/auth.ts` 中的 `listUsers()` 函数，添加 `keyword`（username/email ILIKE 搜索）、`role` 筛选、`from`/`to` 日期范围参数
- [x] 3.2 更新 `routes/admin.ts` 中 `GET /users` 路由，解析 keyword/role/from/to 查询参数并传递给服务层

## 4. 实现管理员专属题目列表

- [x] 4.1 在 `services/problems.ts` 中新增 `listAllProblems()` 函数，返回全量题目（不默认筛选 type='P'），额外返回 owner_username（JOIN users 表）
- [x] 4.2 在 `routes/admin.ts` 中添加 `GET /problems` 路由，调用 listAllProblems 返回全量题目列表

## 5. 实现管理员提交详情与删除

- [x] 5.1 在 `routes/admin.ts` 中添加 `GET /submissions/:id` 路由，调用 `getSubmission()` 但不传入 userId（跳过所有权检查）
- [x] 5.2 在 `services/submissions.ts` 中新增 `deleteSubmission()` 函数：硬删除提交记录及关联评测结果（ON DELETE CASCADE）
- [x] 5.3 在 `routes/admin.ts` 中添加 `DELETE /submissions/:id` 路由，调用 deleteSubmission 服务

## 6. 实现管理员编辑用户资料

- [ ] 6.1 在 `services/users.ts` 中新增 `adminUpdateUserProfile()` 函数，支持更新指定用户的 email 和 bio，包含邮箱唯一性检查和格式校验
- [ ] 6.2 在 `routes/admin.ts` 中添加 `PUT /users/:id` 路由，解析 email/bio 字段，调用 adminUpdateUserProfile

## 7. 添加测试

- [x] 7.1 添加仪表盘统计 API 的测试用例
- [x] 7.2 添加管理员题目列表 API 的测试用例
- [x] 7.3 添加用户搜索筛选功能的测试用例
- [x] 7.4 添加管理员编辑用户资料 API 的测试用例
- [x] 7.5 添加管理员提交详情和删除 API 的测试用例
- [x] 7.6 运行 `deno task test` 确认全部测试通过（32 passed, 0 failed）
