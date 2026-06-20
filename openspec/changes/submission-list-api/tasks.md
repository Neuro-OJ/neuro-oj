## 1. Service 层 — 列表查询

- [ ] 1.1 在 `services/submissions.ts` 中实现 `listSubmissions` 函数，接受筛选参数（userId、problemId、language、status、from、to）和分页参数（page、perPage），返回 `{ data, total }`
- [ ] 1.2 使用 Drizzle ORM 编写单次 JOIN 查询：`submissions` LEFT JOIN `problems` LEFT JOIN `evaluationResults`，一次请求获取提交+题目+评测摘要
- [ ] 1.3 根据筛选参数动态构建 WHERE 条件（仅对提供的参数添加条件子句）
- [ ] 1.4 实现 offset-based 分页：先 COUNT 总数，再 OFFSET/LIMIT 查询
- [ ] 1.5 定义 `SubmissionListItem` 响应类型（不含 code 字段，含 problem 和 result 摘要）

## 2. Route 层 — 用户提交列表

- [ ] 2.1 在 `routes/submissions.ts` 中添加 `GET /` 路由，使用 `authMiddleware` 保护
- [ ] 2.2 解析查询参数（problem_id、language、status、from、to、page、per_page），进行参数校验和默认值处理
- [ ] 2.3 调用 `listSubmissions` 服务函数，将结果与 pagination 元数据组装后返回 200

## 3. Route 层 — 管理员提交列表

- [ ] 3.1 在 `routes/submissions.ts` 中导出 `adminSubmissions` Hono 实例，添加 `GET /` 路由，使用 `authMiddleware` + `adminMiddleware` 保护
- [ ] 3.2 解析查询参数（额外支持 `user_id`），调用 `listSubmissions` 并返回所有用户数据
- [ ] 3.3 在 `app.ts` 中注册 `adminSubmissions` 路由，挂载到 `/api/v1/admin/submissions`

## 4. 测试

- [ ] 4.1 编写 `GET /api/v1/submissions` 的测试用例：无筛选分页、按 problem_id 筛选、按 status 筛选、按日期范围筛选、多条件组合、空结果、未认证访问
- [ ] 4.2 编写 `GET /api/v1/admin/submissions` 的测试用例：管理员查看所有提交、按 user_id 筛选、普通用户被拒绝、未登录被拒绝
