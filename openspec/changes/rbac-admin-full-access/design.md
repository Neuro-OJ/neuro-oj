## Context

RBAC（#171）已落地：权限判定核心在 `noj-core/src/lib/permissions.ts`（递归 CTE + 请求级缓存），角色继承（`roles.parent_id`）已在 `getUserPermissions` 中生效，但有两个遗留问题：

1. **`is_admin` 是角色布尔属性**：JWT 签发（`auth.ts:305-313`）与 admin 守卫（`middleware/auth.ts`）只查直接关联角色的 `is_admin`，不沿继承链递归；而 `getUserPermissions` 的 CTE 用 `WHERE rr.is_admin = false` 把 admin 角色权限行过滤掉——继承链上出现 admin 角色时语义断裂。
2. **`users.role` 与 RBAC 双轨**：展示（listUsers）、封禁保护（`users.ts:542`）、seed 幂等（`seed-system.ts`）、迁移（`seed-rbac.ts migrateExistingUsers`）仍依赖旧字段，RBAC 提升的用户（role 列未同步）无封禁保护。

用户已拍板三个决策：① JWT 移除 `is_admin` claim、实时查权限；② `roles.is_admin` 删列迁移；③ 权限标识用 `admin:full_access`。另明确要求同步更新初始化脚本。

## Goals / Non-Goals

**Goals:**
- `is_admin` 语义统一为权限 `admin:full_access`，复用 `getUserPermissions` 递归 CTE（含继承链），消除双轨
- JWT 移除 `is_admin` claim，管理守卫实时查权限（请求级缓存），权限变更即时生效
- 删除 `users.role` 与 `roles.is_admin` 两列（Drizzle 迁移），清理全部读写点与初始化脚本
- 前端展示与筛选同步（`is_admin` 字段）

**Non-Goals:**
- 不引入权限通配符语法（`*:*`）；全权限仅由 `admin:full_access` 表达
- 不重构 `permissions` 表结构（沿用 resource:action）
- 不改角色继承机制本身（parent_id 语义不变）
- 不处理历史 JWT 的滚动失效（旧 token 的 `is_admin` claim 将被忽略，仅依赖实时查询）

## Decisions

### D1: `admin:full_access` 权限建模
- `permissions` 表新增一行：`resource='admin'`, `action='full_access'`，权限串 `admin:full_access`
- `seed-rbac.ts` 的 `SYSTEM_PERMISSIONS` 加入该权限；admin 角色在 `role_permissions` 关联它（seed 幂等 ON CONFLICT DO NOTHING）
- 删除 `roles.is_admin` 列的写入与读取；`listRoles` 的 `is_admin` 展示字段改为"该角色是否关联 `admin:full_access` 权限"（查询 role_permissions），或前端改为展示该权限的勾选状态

### D2: 权限检查统一（通配放行）
- `getUserPermissions` CTE：去掉 `WHERE rr.is_admin = false`，所有角色（含 admin）的权限统一聚合（继承递归保留）
- `checkPermission` / `requirePermission` / `assertPermission`：移除 `c.var.isAdmin` fast path，判定改为：
  ```ts
  perms.has("admin:full_access") || perms.has(permission)
  ```
- 即 `admin:full_access` 成为"全权限通行证"，与现有 `ADMIN_DEFAULT_PERMISSIONS`（社区治理权限的显式授权）兼容——显式授权保留，但全权限由该权限兜底

### D3: JWT 与实时权限
- 登录签发（`auth.ts`）：payload 移除 `is_admin`；`role` claim 保留（仅供审计日志 `actorRole` 与展示，无权限语义）——`jwtRole` 计算逻辑改为基于权限集（含 `admin:full_access` 时取 admin 角色名）或直接简化为 role 名称
- `middleware/auth.ts`：`AuthEnv` 移除 `isAdmin` 字段；`authMiddleware` 不再注入；`adminMiddleware`（兼容逻辑 `!isAdmin && userRole !== "admin"`）重写为 `resolvePermissions(c)` 实时判断 `admin:full_access`
- `requireAdmin()`：同样改为实时查询（`resolvePermissions` 请求级缓存保证一个请求内多中间件只查一次 DB）
- 旧 token：`is_admin` claim 被忽略，无安全影响（判定只信实时权限）

### D4: 删列迁移（`users.role`、`roles.is_admin`）
- 顺序：先清全部代码引用（含 seed/tests）→ 再 `deno task db:generate` 生成两条删列迁移 → 迁移执行
- `users` 表删除 `role` 列后：注册（`auth.ts:156/191`）、root 创建（`auth.ts:628`）、bootstrap:admin（`seed-system.ts`）、`migrateExistingUsers`（`seed-rbac.ts`）全部改为只操作 `user_roles`
- `listUsers`（`auth.ts:484`）移除 `role` 字段，`is_admin` 从权限集计算（替代 TODO 硬编码 false）；`role` 查询筛选参数（`auth.ts:403-404`）改为 `is_admin=true|false`（按权限集筛选，需对整页用户批量算权限或 JOIN role_permissions）
- 封禁保护（`users.ts:542`）：统计"拥有 `admin:full_access` 权限的用户数"（含继承），替代 `count(users.role='admin')`
- `seed-rbac.ts migrateExistingUsers`：存量迁移目标改为"为尚无 user_roles 关联的用户补默认 user 角色"（不再读 `users.role`；历史已迁移过的数据不受影响）

### D5: 前端同步
- `users.vue`：`User` 接口移除 `role`、加 `is_admin`；角色徽章 `row.original.role === 'admin'` → `row.original.is_admin`；筛选参数 `role` → `is_admin`
- `roles.vue`：角色列表/编辑的 `is_admin` 列改为展示/勾选 `admin:full_access` 权限关联
- `useContests` 等依赖 `role` 字段的调用点全量 grep 清理

## Risks / Trade-offs

- [管理路由从零 DB 变为每请求一次权限查询] → `resolvePermissions` 请求级缓存（同一请求内所有权限检查共享一次查询）；admin 场景低频，可接受
- [JWT 不再携带权限快照，频繁请求的管理页每请求查询] → 同上；后续如性能敏感可加短 TTL 缓存（本次不做）
- [删列迁移不可逆] → 先备份/在 dev 验证；迁移前确保所有代码引用清零（CI 测试兜底）
- [`listUsers` 按 `is_admin` 筛选需对用户批量解析权限] → 实现上用一次 `user_roles ⋈ roles ⋈ role_permissions` 聚合查询批量计算，避免 N+1
- [旧 token 中 `role` claim 与实时权限可能短暂不一致（展示用）] → role claim 仅审计/展示，无权限影响

## Migration Plan

1. 代码改造（permissions/auth/middleware/services/seed）→ 全量测试通过（此时 `roles.is_admin` 仍存在但零引用，`users.role` 零引用）
2. `deno task db:generate` 生成 `ALTER TABLE roles DROP COLUMN is_admin`、`ALTER TABLE users DROP COLUMN role`
3. `deno task db:migrate` 执行；验证 `init:system` / `bootstrap:admin` 幂等
4. noj-ui 同步 + build + 冒烟（登录/权限/封禁保护/角色编辑）
5. 提交（jj，Conventional Commits，scope `core,ui`）

## Open Questions

- `listUsers` 的 `role` 筛选参数对外兼容性：前端与测试同步改 `is_admin` 参数即可，无外部 API 消费者（无 Open Questions，实施时确认 tests）
