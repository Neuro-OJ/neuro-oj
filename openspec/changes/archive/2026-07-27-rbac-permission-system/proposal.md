## Why

当前权限系统是二进制硬编码字符串比较（`userRole === "admin"` 出现 27+ 处），无类型安全、无粒度控制、无集中管理。Phase 2 比赛系统需要 `contest_organizer`、`problem_setter`、`moderator` 等中间角色，现有架构每增加一个角色需修改所有硬编码位置，不可持续。本次重构引入 RBAC，同时保持向前兼容。

## What Changes

- 新建 `roles`、`permissions`、`role_permissions`、`user_roles` 四张表，保留 `users.role` 列向前兼容
- 引入角色继承（单父，WITH RECURSIVE）、`is_admin`/`is_default`/`is_system` 标记
- 创建 `checkPermission(userId, permission)` 函数：一次递归 CTE 取出用户所有权限（`Set<string>`），TypeScript 端 `Set.has()` 精确匹配
- 管理员后台提供角色 CRUD + 权限勾选编辑器，含服务端约束防止锁死
- 系统默认提供 `admin`（is_admin=true）和 `user`（is_default=true）两个系统角色
- JWT 保留 `role` 字段用于 admin fast path（跳过 DB），细粒度权限走 `checkPermission`
- 现有硬编码 `userRole === "admin"` 逐步替换为 `checkPermission()` 调用
- **BREAKING**：`PATCH /api/v1/admin/users/:id/role` 的 `role` 字段从 `"admin"|"user"` 字符串变为 `role_id` UUID（通过 `user_roles` 表管理）

## Capabilities

### New Capabilities
- `rbac-core`: RBAC 核心——角色、权限、用户-角色关联的数据模型、权限检查函数、角色继承逻辑
- `admin-role-management`: 管理员角色管理器——角色 CRUD + 权限勾选编辑器 UI + 服务端约束

### Modified Capabilities
- `admin-authorization`: 权限检查从硬编码字符串比较迁移到 `checkPermission()` 调用，中间件策略调整为 admin fast path + 细粒度检查
- `database-schema`: 新增 4 张 RBAC 表，`users.role` 列保留但标记为 deprecated
- `cookie-auth`: JWT `role` 字段语义从"唯一权限来源"变为"admin fast path 标记"，登录时同步写入 `user_roles` 以保证一致性

## Impact

- **数据库**：新增 4 张表 + 1 个 Drizzle 迁移；`users.role` 列保留不删
- **API**：`PATCH /api/v1/admin/users/:id/role` 改为管理 `user_roles` 关联（**BREAKING**）；新增角色管理 CRUD 端点
- **中间件**：`adminMiddleware` 增加 fast path 逻辑；新增 `requirePermission(perm)` 中间件
- **服务层**：`problems-crud.ts`、`support-package.ts`、`submissions-crud.ts`、`search.ts` 中的硬编码角色检查替换
- **Seed**：新增系统角色和权限定义的初始化逻辑
- **noj-ui**：新增管理员角色编辑器页面；前端角色守卫更新
