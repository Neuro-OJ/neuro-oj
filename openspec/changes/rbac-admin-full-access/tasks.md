## 1. 权限核心改造（lib/permissions.ts）

- [x] 1.1 `getUserPermissions`：递归 CTE 去掉 `WHERE rr.is_admin = false` 过滤，所有角色（含 admin）权限统一聚合，继承递归保留
- [x] 1.2 `checkPermission` / `assertPermission` / `requirePermission`：移除 `c.var.isAdmin` fast path，判定改为 `perms.has("admin:full_access") || perms.has(permission)`
- [x] 1.3 `requireAdmin()`：改为 `resolvePermissions(c)` 实时查询 `admin:full_access`（请求级缓存），错误信息保持"需要管理员权限"

## 2. 认证与中间件

- [x] 2.1 `middleware/auth.ts`：`AuthEnv` 移除 `isAdmin` 字段；`authMiddleware` 不再注入 `isAdmin`；`adminMiddleware` 重写为实时权限判断（移除 `userRole !== "admin"` 兼容逻辑）
- [x] 2.2 `auth.ts` 登录签发：JWT payload 移除 `is_admin`；`jwtRole` 计算改为基于角色名（不再读 `roles.is_admin`），`role` claim 仅审计/展示用
- [x] 2.3 校验侧：`verifyToken` / `authMiddleware` 忽略旧 token 中残留的 `is_admin` claim，不写入上下文

## 3. users.role 清理、seed 更新与删列迁移

- [x] 3.1 `auth.ts`：注册（register）与 root 用户创建不再写 `users.role`；`listUsers` 移除 `role` 字段、`is_admin` 改为真实计算（批量解析用户权限集，避免 N+1）；`role` 查询筛选参数改为 `is_admin=true|false`；移除 `users.role`→角色 id 的 fallback 兜底逻辑
- [x] 3.2 `seed-system.ts`：`ensureBootstrapAdmin` 幂等判断（`user.role === "admin"`）与提升逻辑改为查 `user_roles` / `admin:full_access`；不再写 `users.role`
- [x] 3.3 `seed-rbac.ts`：`SYSTEM_PERMISSIONS` 新增 `admin:full_access`（23 个）；admin 角色在 `role_permissions` 关联它；`migrateExistingUsers` 改为"为无 user_roles 关联的存量用户补默认 user 角色"（不再读 `users.role`）
- [x] 3.4 `users.ts` 封禁保护：统计"拥有 `admin:full_access` 权限（含继承）的用户数"替代 `count(users.role='admin')`
- [x] 3.5 `admin-roles.ts`：`listRoles` 的 `is_admin` 展示改为查询该角色是否关联 `admin:full_access`；`updateUserRoles` 最后管理员保护改为权限集统计；`createRole` 不再写 `roles.is_admin`
- [x] 3.6 `db/schema.ts` 移除 `users.role` 与 `roles.is_admin` 两列；`deno task db:generate` 生成删列迁移；`deno task db:migrate` 执行（dev 库验证）

## 4. 前端同步（noj-ui）

- [x] 4.1 `pages/admin/users.vue`：`User` 接口 `role` → `is_admin`；角色徽章改为 `row.original.is_admin`；筛选参数同步
- [ ] 4.2 `pages/admin/roles.vue`：角色列表/编辑的 `is_admin` 展示与勾选改为 `admin:full_access` 权限关联
- [x] 4.3 全量 grep noj-ui 中 `role` 字段依赖点（如 useContests、提交列表等）确认无残留

## 5. 测试更新

- [x] 5.1 noj-core tests：更新 is_admin（33 处）/ role（349 处）相关引用；新增继承链 admin:full_access 场景测试（子角色继承父角色管理员权限）
- [ ] 5.2 noj-tests E2E：RBAC / 鉴权守卫场景同步（管理员判定、封禁保护、bootstrap 幂等）

## 6. 验证与提交

- [ ] 6.1 noj-core：`deno fmt` + `deno lint` + `deno task test` 全量通过
- [ ] 6.2 noj-ui：`deno fmt` + `deno lint` + `nuxt build` 通过
- [ ] 6.3 冒烟：登录（JWT 无 is_admin claim）、管理员访问 /admin、权限变更即时生效（移除 admin:full_access 后 403）、封禁最后管理员保护、`init:system`/`bootstrap:admin` 幂等、角色继承（子角色继承 admin）
- [ ] 6.4 确认 GPG 签名后按项目规范提交（jj，中文 Conventional Commits，scope `core,ui`）
