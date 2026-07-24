## 1. 数据库 Migration

- [x] 1.1 创建 `roles`、`permissions`、`role_permissions`、`user_roles` 四张表的 Drizzle migration
- [x] 1.2 在 `src/db/schema.ts` 中定义四张表的 Drizzle schema
- [x] 1.3 运行 migration 验证表结构正确创建

## 2. Seed 数据

- [x] 2.1 `src/services/seed-rbac.ts`：`ensureSystemRoles()` 创建 admin + user 角色
- [x] 2.2 22 个系统权限定义（ON CONFLICT DO NOTHING）
- [x] 2.3 user 角色关联 9 个默认权限
- [x] 2.4 现有 users.role 同步到 user_roles 表
- [x] 2.5 `src/main.ts` 启动顺序集成 RBAC seed
- [x] 2.6 `scripts/seed.ts` 集成 RBAC seed

## 3. 权限检查核心

- [x] `src/lib/permissions.ts`：`getUserPermissions()` 递归 CTE → Set<string>
- [x] `checkPermission(c, perm)` / `assertPermission(c, perm)` 工具函数
- [x] `resolvePermissions(c)` 请求级缓存（同一请求零额外 DB 查询）
- [x] `requirePermission(perm)` 中间件：isAdmin fast path → DB fallback

## 4. 认证中间件更新

- [x] `authMiddleware` / `optionalAuthMiddleware` 注入 `isAdmin` context variable
- [x] `TokenPayload` 新增 `is_admin` 布尔 claim
- [x] `AuthEnv` 新增 `isAdmin` 字段
- [x] `adminMiddleware` 向后兼容：同时检查 `isAdmin` 和 `role === "admin"`
- [x] 登录逻辑从 `user_roles` + `roles` 表推导 `is_admin`
- [x] 注册逻辑通过 `is_default=true` 查询默认角色（不依赖角色名）

## 5. 类型更新

- [x] `src/types/auth.ts`：`Role` type, `ROLES` const, `UserResponse.isAdmin` 字段
- [ ] `src/types/index.ts`：添加 `Permission` 相关类型

## 6. 用户角色管理 API

- [x] `src/services/admin-roles.ts`：角色 CRUD + 权限管理 + 用户角色分配
- [x] `GET /api/v1/admin/roles`、`POST`、`PUT /:id`、`DELETE /:id`
- [x] `GET /api/v1/admin/permissions`
- [x] `PATCH /api/v1/admin/users/:id/role` → `{ role_ids: [...] }`（BREAKING）
- [x] 服务端约束：系统角色保护、最后一个 admin 保护、循环继承检测
- [x] 在 `src/routes/admin.ts` 中挂载

## 7. 管理员后台 UI

- [ ] 7.1 `noj-ui/pages/admin/roles.vue`
- [ ] 7.2 角色编辑弹窗组件
- [ ] 7.3 `is_admin` 角色 → 权限区域不可见 + 提示
- [ ] 7.4 继承权限 🔒 灰色禁用
- [ ] 7.5 前端 PATCH 调用更新
- [ ] 7.6 `useAuth.ts` + `middleware/admin.ts` 更新

## 8. 服务层迁移（硬编码 → checkPermission）

- [ ] 5.1 `problems-crud.ts`：`userRole !== "admin"` → `checkPermission()` 等
- [ ] 5.2 `support-package.ts`：替换 + 修复 `getSupportPackageBytes`
- [ ] 5.3 `submissions-crud.ts`：`viewerRole === "admin"` 替换
- [ ] 5.4 `search.ts`：`isAdmin` 参数替换

## 9. 测试 + 文档

- [ ] 8.1-8.4 单元测试 / 集成测试
- [ ] 9.1 更新 `noj-core/CLAUDE.md`
- [ ] 9.2 验证 `deno task test`（现有 23 个失败为测试并发问题，非 RBAC 引入）
