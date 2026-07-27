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
- [x] `src/types/index.ts`：添加 `Permission` 相关类型

## 6. 用户角色管理 API

- [x] `src/services/admin-roles.ts`：角色 CRUD + 权限管理 + 用户角色分配
- [x] `GET /api/v1/admin/roles`、`POST`、`PUT /:id`、`DELETE /:id`
- [x] `GET /api/v1/admin/permissions`
- [x] `PATCH /api/v1/admin/users/:id/role` → `{ role_ids: [...] }`（BREAKING）
- [x] 服务端约束：系统角色保护、最后一个 admin 保护、循环继承检测
- [x] 在 `src/routes/admin.ts` 中挂载

## 7. 管理员后台 UI

- [x] 7.1 `noj-ui/pages/admin/roles.vue` — 角色管理列表页 + 角色编辑弹窗
- [x] 7.2 角色编辑弹窗组件（内置于 roles.vue）
- [x] 7.3 `is_admin` 角色 → 权限区域不可见 + ⚠️ 提示
- [x] 7.4 继承权限 🔒 灰色禁用 + "继承"标记
- [x] 7.5 前端 PATCH 调用更新（users.vue → `role_ids` 多选格式）
- [x] 7.6 `useAuth.ts` + `middleware/admin.ts` → `is_admin` 字段支持

## 8. 服务层迁移（硬编码 → checkPermission）

- [x] 5.1 `problems-crud.ts`：`userRole !== "admin"` → `assertPermission()` 等
- [x] 5.2 `support-package.ts`：替换 + 修复 `getSupportPackageBytes`
- [x] 5.3 `submissions-crud.ts`：`viewerRole === "admin"` → `c.var.isAdmin` + RBAC
- [x] 5.4 `search.ts`：`isAdmin` 参数替换 → `c.var.isAdmin`

## 9. 测试 + 文档

- [x] 8.1-8.4 单元测试 + 集成测试
  - `tests/services/rbac.test.ts` — **19 个**测试全通过（+7 新缺口覆盖）
  - `noj-tests/e2e/16_rbac.test.ts` — 5 个 E2E 集成测试
- [x] 9.1 更新 `noj-core/AGENTS.md` → 新增 RBAC 权限系统章节
- [x] 9.2 验证 `deno check` → 所有 96 个文件编译通过，`deno fmt` 格式合规
