## 1. Service 层 — 用户主页聚合查询

- [x] 1.1 新建 `services/users.ts`，实现 `getUserProfile` 函数，接受 `userId` 参数
- [x] 1.2 实现统计查询：从 submissions LEFT JOIN evaluation_results 聚合 total_submissions、accepted（status='Accepted'）、acceptance_rate
- [x] 1.3 实现已通过题目列表查询：查询 evaluation_results.status='Accepted' 的提交，按 problem_id 去重，取首次通过时间，JOIN problems 获取标题和难度
- [x] 1.4 实现最近提交查询：取最近 10 条提交，LEFT JOIN problems 获取题目标题，LEFT JOIN evaluation_results 获取评测状态和分数，不含 code 字段
- [x] 1.5 定义 `UserProfileResponse` 类型（含 user、stats、solved_problems、recent_submissions）

## 2. Route 层 — 用户主页端点

- [x] 2.1 新建 `routes/users.ts`，添加 `GET /:id/profile` 路由（无需认证）
- [x] 2.2 调用 `getUserProfile` 服务函数，返回 200 + 聚合数据
- [x] 2.3 在 `app.ts` 中注册用户路由，挂载到 `/api/v1/users`

## 3. 测试

- [x] 3.1 编写单元测试：查看存在的用户主页、不存在的用户返回 404、无提交用户的统计为零值、统计聚合正确性、已通过题目去重、最近提交不含 code 字段
- [x] 3.2 编写 E2E 测试：查看存在的用户主页、不存在的用户返回 404、无提交用户的空数据
