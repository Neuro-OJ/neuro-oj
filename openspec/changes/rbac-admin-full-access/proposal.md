## Why

RBAC 落地后 `users.role` 与 `roles.is_admin` 成为遗留的"双轨"字段：权限判定实际由 `user_roles ⋈ roles` 决定，但展示、封禁保护、seed 幂等判断仍混用旧字段，导致角色变更后展示漂移、RBAC 提升的管理员无封禁保护。同时 `is_admin` 作为角色布尔属性无法与角色继承（`roles.parent_id`）统一——继承链上出现 admin 角色时 is_admin 判定与权限聚合语义断裂（`getUserPermissions` 的 CTE 用 `WHERE rr.is_admin = false` 排除了 admin 角色的权限行）。

## What Changes

- **`is_admin` 语义改为权限**：`permissions` 表新增 `admin:full_access`（resource=`admin`, action=`full_access`），admin 角色在 `role_permissions` 关联该权限；用户是否为管理员 = 权限集（含继承链）是否含 `admin:full_access`，复用 `getUserPermissions` 递归 CTE
- **权限检查统一**：`checkPermission`/`requirePermission`/`assertPermission` 移除 `c.var.isAdmin` fast path，改为权限集含 `admin:full_access` 时通配放行（`perms.has("admin:full_access") || perms.has(permission)`）；递归 CTE 去掉 `WHERE rr.is_admin = false` 过滤
- **JWT 移除 `is_admin` claim**：登录签发不再写该 claim，`requireAdmin`/`adminMiddleware` 改为每次请求实时查权限集（请求级缓存 `resolvePermissions`），权限变更即时生效
- **`roles.is_admin` 删列迁移**：判定逻辑全部移除后 `ALTER TABLE roles DROP COLUMN is_admin`（Drizzle 迁移），seed 不再写该列
- **`users.role` 彻底废弃并删列迁移**：`ALTER TABLE users DROP COLUMN role`；注册/root/bootstrap 不再写；`listUsers` 移除 `role` 字段、`is_admin` 改为真实计算（当前为 TODO 硬编码 false）；`role` 查询筛选参数改为 `is_admin`；移除 `users.role`→角色 id 的 fallback 兜底；封禁保护统计改为 RBAC 权限
- **初始化脚本更新**（用户明确要求）：`seed-rbac.ts` 预置 `admin:full_access` 权限并授权 admin 角色、`migrateExistingUsers` 改查 RBAC 关联（不再依赖 `users.role`）；`seed-system.ts` bootstrap:admin 幂等判断与提升逻辑改查 `user_roles`，不再写 `users.role`
- **前端同步**：`admin/users.vue` 角色徽章改读 `is_admin`；`admin/roles.vue` 角色列表/编辑的 is_admin 展示改为 `admin:full_access` 权限关联；`admin/users` 筛选参数同步

## Capabilities

### New Capabilities

- （无新增；复用现有 rbac-core）

### Modified Capabilities

- `rbac-core`: `is_admin` 标记需求改为 `admin:full_access` 权限语义；`getUserPermissions`/`checkPermission` 行为变更（含继承的统一查询与通配放行）；移除"向前兼容 users.role 列"需求；数据迁移需求改为 RBAC 关联判断
- `admin-authorization`: 管理端点守卫从 JWT `is_admin` claim 改为实时权限查询；种子脚本初始化管理员逻辑变更
- `user-auth`: 登录 JWT payload 移除 `is_admin` claim
- `database-schema`: `users.role` 与 `roles.is_admin` 两列删除

## Impact

- **noj-core**：`lib/permissions.ts`、`middleware/auth.ts`、`services/auth.ts`、`services/admin-roles.ts`、`services/users.ts`（封禁保护）、`services/seed-rbac.ts`、`services/seed-system.ts`、`db/schema.ts` + 新迁移、`routes/admin.ts`（筛选参数）
- **noj-ui**：`pages/admin/users.vue`、`pages/admin/roles.vue`
- **测试**：noj-core tests（is_admin 33 处、role 349 处引用需同步）、noj-tests E2E（RBAC/鉴权场景）
- **数据库**：两条删列迁移（`users.role`、`roles.is_admin`），需先清代码引用再执行
