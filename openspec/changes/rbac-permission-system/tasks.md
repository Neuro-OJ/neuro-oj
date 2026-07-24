## 1. 数据库 Migration

- [ ] 1.1 创建 `roles`、`permissions`、`role_permissions`、`user_roles` 四张表的 Drizzle migration（`drizzle/` SQL 文件）
- [ ] 1.2 在 `src/db/schema.ts` 中定义四张表的 Drizzle schema
- [ ] 1.3 运行 migration 验证表结构正确创建

## 2. Seed 数据

- [ ] 2.1 在 `src/services/` 中创建 `seed-rbac.ts`：`ensureSystemRoles()` 创建 admin（is_admin=true）和 user（is_default=true）角色
- [ ] 2.2 实现 `ensurePermissions()`：插入 22 个系统权限定义（ON CONFLICT DO NOTHING）
- [ ] 2.3 实现 `ensureUserRolePermissions()`：为 user 角色关联 9 个默认权限
- [ ] 2.4 实现 `migrateExistingUsers()`：将现有 `users.role` 同步到 `user_roles` 表
- [ ] 2.5 更新 `src/main.ts` 启动顺序，在 migration 后调用 seed 逻辑
- [ ] 2.6 更新 `scripts/seed.ts` 集成 RBAC seed

## 3. 权限检查核心

- [ ] 3.1 在 `src/lib/permissions.ts` 中实现 `getUserPermissions(userId)`：递归 CTE 查询，返回 `Set<string>`
- [ ] 3.2 实现 `checkPermission(userId, permission)`：admin fast path + `Set.has()` 检查
- [ ] 3.3 实现 `isAdminRole(roleName)` 辅助函数（判断角色名是否对应 is_admin=true 的角色）
- [ ] 3.4 添加 `getUserPermissions` 和 `checkPermission` 的单元测试（PGlite 或 mock）

## 4. 认证中间件更新

- [ ] 4.1 实现 `requireAdmin()` 中间件：基于 `c.var.isAdmin` 的纯 JWT 检查，零 DB 查询（替代原 `adminMiddleware`）
- [ ] 4.2 实现 `requirePermission(permission)` 中间件工厂函数：`isAdmin` fast path → `resolvePermissions(c)` DB fallback
- [ ] 4.3 实现 `checkPermission(c, perm)` 和 `assertPermission(c, perm)` 工具函数（供 handler/service 内部使用）
- [ ] 4.4 实现 `resolvePermissions(c)` 请求级缓存函数
- [ ] 4.5 更新 `TokenPayload` 和 `AuthEnv`：新增 `is_admin` 布尔 claim，`isAdmin` context variable
- [ ] 4.6 更新登录逻辑（`src/services/auth.ts`）：从 `user_roles` + `roles` 表查询角色，推导 `is_admin` claim
- [ ] 4.7 更新注册逻辑：通过 `is_default=true` 查询默认角色（不依赖角色名称）

## 5. 服务层迁移（硬编码 → checkPermission）

- [ ] 5.1 `src/services/problems-crud.ts`：将 `userRole !== "admin"` 替换为 `checkPermission(userId, "problem:create_p")` 等
- [ ] 5.2 `src/services/support-package.ts`：替换为 `checkPermission` 调用，修复 `getSupportPackageBytes` 权限不一致
- [ ] 5.3 `src/services/submissions-crud.ts`：`getSubmission()` 中使用 `checkPermission(userId, "submission:read_all")` 替代 `viewerRole === "admin"`
- [ ] 5.4 `src/services/search.ts`：`searchUsers()` 中使用 `checkPermission(userId, "user:search")` 替代 `isAdmin` 参数
- [ ] 5.5 更新 `src/types/auth.ts`：添加 `Role` union type 和 `ROLES` 常量，更新 `UserResponse`
- [ ] 5.6 更新 `src/types/index.ts`：添加 `Permission` 相关类型

## 6. 用户角色管理 API

- [ ] 6.1 创建 `src/routes/admin/roles.ts`：`GET /api/v1/admin/roles`（角色列表）
- [ ] 6.2 `POST /api/v1/admin/roles`（创建角色）
- [ ] 6.3 `PUT /api/v1/admin/roles/:id`（编辑角色）
- [ ] 6.4 `DELETE /api/v1/admin/roles/:id`（删除角色，含继承引用检查）
- [ ] 6.5 `GET /api/v1/admin/permissions`（权限定义列表，按 resource 分组）
- [ ] 6.6 `PATCH /api/v1/admin/users/:id/role`：改为接受 `{ "role_ids": [...] }`（**BREAKING**）
- [ ] 6.7 服务端约束：防止删除系统角色、防止移除最后一个 admin、循环继承检测
- [ ] 6.8 在 `src/routes/admin.ts` 中挂载角色管理路由

## 7. 管理员后台 UI

- [ ] 7.1 创建 `noj-ui/pages/admin/roles.vue`：角色列表页面
- [ ] 7.2 创建角色编辑弹窗组件：名称、描述、父角色下拉
- [ ] 7.3 `is_admin=true` 角色 → 权限勾选区域不可见，显示"⚠️ 管理员角色隐式拥有所有权限，无需单独配置"
- [ ] 7.4 非管理员角色 → 按 resource 分组的权限勾选列表；继承父角色的权限显示 🔒 灰色禁用（不可取消）
- [ ] 7.5 更新 `PATCH /users/:id/role` 调用为新 API 格式（`role_ids` 数组）
- [ ] 7.6 更新前端 `useAuth.ts`：session cookie 增加 `isAdmin` 字段
- [ ] 7.7 更新前端 `middleware/admin.ts`：基于 `isAdmin` 字段判断

## 8. 测试

- [ ] 8.1 编写 `checkPermission` 的单元测试（admin fast path、精确匹配、继承链、多角色并集）
- [ ] 8.2 更新现有路由测试确保 RBAC 迁移后行为一致
- [ ] 8.3 编写角色 CRUD API 的集成测试
- [ ] 8.4 编写服务层迁移后的回归测试（problem CRUD、support package、submission）

## 9. 文档与清理

- [ ] 9.1 更新 `noj-core/CLAUDE.md` 中的权限系统描述
- [ ] 9.2 更新 `noj-core/.env.example` 如有需要
- [ ] 9.3 验证 `deno task test` 全部通过
- [ ] 9.4 验证 `deno task seed` 全新部署 + 重复执行幂等
