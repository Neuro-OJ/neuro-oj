## MODIFIED Requirements

### Requirement: admin:full_access 权限（替代 is_admin 标记）

管理员的判定 SHALL 统一为权限 `admin:full_access`（resource=`admin`，action=`full_access`）：用户是否为管理员 = 其权限集（含角色继承链）是否包含 `admin:full_access`。权限检查函数 SHALL 在权限集包含 `admin:full_access` 时对任意权限检查直接放行，不依赖 `roles.is_admin` 布尔属性与角色名称。

JWT SHALL 不包含 `is_admin` claim；`requireAdmin()` 与 `requirePermission()` SHALL 通过 `resolvePermissions`（请求级缓存）实时查询权限集判定。

#### Scenario: 拥有 admin:full_access 权限的用户全权限放行

- **WHEN** 用户的角色（含继承链）拥有 `admin:full_access` 权限
- **THEN** `checkPermission(userId, anyPermission)` 返回 true，无论 `role_permissions` 中是否有该权限记录

#### Scenario: 继承链上的管理员权限生效

- **WHEN** 用户拥有角色 A，角色 A 的 `parent_id` 指向拥有 `admin:full_access` 权限的角色 B
- **THEN** 该用户获得管理员权限，`checkPermission(userId, anyPermission)` 返回 true

#### Scenario: 权限变更即时生效

- **WHEN** 管理员移除某用户的 `admin:full_access` 权限（重新登录前后）
- **THEN** 该用户下一次请求即不再通过 `requireAdmin()`（JWT 无权限快照，实时查询）

### Requirement: getUserPermissions 函数

系统 SHALL 提供 `getUserPermissions(userId)` 函数，通过一次递归 CTE 查询返回用户所有有效权限的 `Set<string>`。

权限格式为 `"resource:action"`（如 `"problem:create"`、`"admin:full_access"`）。

递归 CTE SHALL 沿 `roles.parent_id` 聚合用户全部直接角色与祖先角色的权限，SHALL NOT 按 `is_admin` 过滤任何角色的权限行。

#### Scenario: 普通用户获取权限集

- **WHEN** 调用 `getUserPermissions(userId)` 且该用户仅拥有 "user" 角色（含 10 个权限）
- **THEN** 返回包含 10 个 `"resource:action"` 字符串的 Set

#### Scenario: 多角色用户获取权限并集

- **WHEN** 用户同时拥有 "user"（10 个权限）和 "problem_setter"（额外 3 个权限）两个角色
- **THEN** 返回 13 个权限的并集

#### Scenario: admin 角色权限包含 admin:full_access

- **WHEN** 调用 `getUserPermissions(userId)` 且该用户拥有 admin 角色
- **THEN** 返回的 Set 包含 `"admin:full_access"`

### Requirement: checkPermission 函数

系统 SHALL 提供 `checkPermission(c: Context, permission)` 和 `assertPermission(c: Context, permission)` 两个工具函数。

- `checkPermission`：返回布尔值，用于条件判断
- `assertPermission`：无权限时抛出 `ForbiddenError`，用于断言
- 判定规则：权限集包含 `admin:full_access` 时直接放行，否则 `Set.has(permission)`
- 两者均共享 `resolvePermissions` 的请求级缓存，SHALL NOT 依赖 JWT 中的 `is_admin` claim

#### Scenario: 用户拥有请求的权限

- **WHEN** `checkPermission(c, "problem:create")` 且用户拥有该权限
- **THEN** 返回 true

#### Scenario: 用户不拥有请求的权限

- **WHEN** `checkPermission(c, "problem:create_p")` 且普通用户不拥有该权限
- **THEN** 返回 false

#### Scenario: admin 用户直接放行

- **WHEN** `checkPermission(c, anyPermission)` 且用户权限集包含 `admin:full_access`
- **THEN** 返回 true

### Requirement: 系统预置角色与权限

系统 SHALL 在 `deno task init:system` 时创建以下预置数据：

**角色**：
- `admin`：`is_system=true`, `is_default=false`，无 parent
- `user`：`is_system=true`, `is_default=true`，无 parent

**权限**（23 个）：
- `admin:full_access`
- `problem:create`, `problem:create_p`, `problem:read`
- `problem:write_own`, `problem:write_any`
- `problem:delete_own`, `problem:delete_any`
- `problem:package_manage_own`, `problem:package_manage_any`
- `submission:create`, `submission:read_own`, `submission:read_all`
- `submission:rejudge`
- `user:read_profile`, `user:search`, `user:manage`
- `category:read`, `category:manage`
- `system:settings`, `system:judge_images`, `system:audit_logs`, `system:ip_bans`

`user` 角色 SHALL 默认拥有：`problem:create`, `problem:read`, `problem:write_own`, `problem:delete_own`, `problem:package_manage_own`, `submission:create`, `submission:read_own`, `user:read_profile`, `category:read`。
`admin` 角色 SHALL 拥有 `admin:full_access` 权限（全权限通行证），并可保留社区治理权限的显式授权（展示用）。

#### Scenario: 全新部署 init:system 创建预置角色

- **WHEN** `deno task init:system` 在新数据库上执行
- **THEN** `roles` 表包含 admin 和 user 两个系统角色，`permissions` 表包含 23 条权限定义，`role_permissions` 表包含 admin 角色的 `admin:full_access` 关联与 user 角色的 9 条权限关联

#### Scenario: 重复 init:system 幂等

- **WHEN** `deno task init:system` 在已有预置数据的数据库上再次执行
- **THEN** 系统跳过已存在的角色和权限（ON CONFLICT DO NOTHING）

### Requirement: 数据迁移——现有用户角色同步

系统 SHALL 在 `deno task init:system` / `dev-setup` 执行时，为尚无任何 `user_roles` 关联的存量用户补齐默认 `user` 角色关联（`users.role` 列已删除，迁移不得再依赖该列）。

#### Scenario: 无角色关联的存量用户获得默认角色

- **WHEN** 初始化脚本执行时存在无 `user_roles` 关联的用户
- **THEN** `user_roles` 表插入该用户与 user 角色的关联

#### Scenario: root 用户不参与同步

- **WHEN** 初始化脚本执行
- **THEN** `id='0'` 的 root 用户不在同步范围内（root 用户不可登录，不需要 RBAC 角色）

## REMOVED Requirements

### Requirement: 向前兼容 users.role 列

**Reason**: `users.role` 列已彻底废弃并删列迁移，展示（listUsers）、封禁保护、seed 幂等与迁移全部改为基于 RBAC（`user_roles` / `admin:full_access` 权限），不再保留兼容列。

**Migration**: `ALTER TABLE users DROP COLUMN role`；`listUsers` 响应移除 `role` 字段并以 `is_admin`（权限集计算）替代；封禁保护统计改为权限集；`role` 查询筛选参数改为 `is_admin`。
