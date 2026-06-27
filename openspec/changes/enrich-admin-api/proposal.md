## Why

当前管理后台后端 API 分散且不完整：仪表盘统计接口缺失、题目管理缺少管理员专属全量列表、用户管理缺少搜索筛选能力。这导致前端管理页面（admin dashboard、problem management、user management）无法完整实现规范中定义的功能，管理员体验受限。

## What Changes

- **新增** `GET /api/v1/admin/dashboard/stats` — 平台统计仪表盘接口
- **新增** `GET /api/v1/admin/problems` — 管理员专属题目列表（全类型）
- **增强** `GET /api/v1/admin/users` — 添加搜索与筛选参数
- **新增** `PUT /api/v1/admin/users/:id` — 管理员编辑任意用户的 profile（email、bio 等字段）
- **新增** `GET /api/v1/admin/submissions/:id` — 管理员查看任意提交详情
- **新增** `DELETE /api/v1/admin/submissions/:id` — 管理员删除提交记录
- **重构** 将分散的管理路由集中到 `routes/admin.ts`

## Capabilities

### New Capabilities
- `admin-dashboard-api`：管理后台仪表盘统计数据接口
- `admin-submission-detail`：管理后台提交详情与删除能力

### Modified Capabilities
- `admin-user-management`：增强用户列表端点（搜索筛选）+ 新增管理员编辑用户 profile 端点
- `admin-problem-management`：新增管理员专属题目列表端点
- `admin-authorization`：调整管理路由组织结构

## Impact

- `noj-core/src/routes/` — 新增 `admin.ts`，调整 `auth.ts` 和 `submissions.ts` 中的管理路由
- `noj-core/src/services/` — 新增 `dashboard.ts`，增强 `auth.ts`、`users.ts`、`problems.ts`
- 路由挂载 `app.ts` — 将分散的管理路由统一为单一挂载点 `/api/v1/admin`
- 无破坏性变更，现有 API 路径和签名保持不变
