## Purpose

定义 Neuro OJ RBAC（基于角色的访问控制）核心规范，包括角色-权限数据模型、权限检查函数、角色继承、系统标记以及种子数据初始化。

## Requirements

### Requirement: RBAC 数据模型

系统 SHALL 提供 `roles`、`permissions`、`role_permissions`、`user_roles` 四张表实现基于角色的访问控制。

`roles` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY |
| name | TEXT | NOT NULL, UNIQUE |
| description | TEXT | |
| is_system | BOOLEAN | NOT NULL, DEFAULT false |
| is_default | BOOLEAN | NOT NULL, DEFAULT false |
| is_admin | BOOLEAN | NOT NULL, DEFAULT false |
| parent_id | UUID | REFERENCES roles(id) ON DELETE SET NULL |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

`permissions` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY |
| resource | TEXT | NOT NULL |
| action | TEXT | NOT NULL |
| description | TEXT | |
| UNIQUE (resource, action) | | |

`role_permissions` 表：
| 字段 | 类型 | 约束 |
|------|------|------|
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| permission_id | UUID | REFERENCES permissions(id) ON DELETE CASCADE |
| PRIMARY KEY (role_id, permission_id) | | |

`user_roles` 表：
| 字段 | 类型 | 约束 |
|------|------|------|
| user_id | UUID | REFERENCES users(id) ON DELETE CASCADE |
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| PRIMARY KEY (user_id, role_id) | | |

#### Scenario: 创建新角色并分配权限
- **WHEN** 管理员创建一个名为 "moderator" 的角色，并关联 `problem:write_any` 和 `submission:read_all` 权限
- **THEN** `roles` 表中新增一行，`role_permissions` 表中新增两行关联

#### Scenario: 为用户分配角色
- **WHEN** 管理员将用户 U 关联到 "moderator" 角色
- **THEN** `user_roles` 表中新增一行 `(user_id=U, role_id=moderator)`

#### Scenario: 删除角色时级联清理
- **WHEN** 删除一个角色
- **THEN** `role_permissions` 和 `user_roles` 中关联该角色的行被级联删除

### Requirement: is_admin 标记

`is_admin=true` 的角色 SHALL 隐式拥有所有权限。权限检查函数遇到 `is_admin=true` 时直接返回 true，不查询 `role_permissions` 表。

**权限判断 SHALL 依赖 `is_admin` 布尔属性，不依赖角色名称。**

JWT SHALL 包含 `is_admin` 布尔 claim，由登录时从 `user_roles` + `roles.is_admin` 推导。`requireAdmin()` 和 `requirePermission()` 中间件 SHALL 通过 `c.var.isAdmin` 进行 fast path 判断。

#### Scenario: admin 角色无需显式分配权限
- **WHEN** 用户拥有 `is_admin=true` 的角色
- **THEN** `checkPermission(userId, anyPermission)` 始终返回 true，无论 `role_permissions` 中是否有记录

#### Scenario: 角色重命名后权限不受影响
- **WHEN** 管理员将 `is_admin=true` 的角色名称从 "admin" 改为 "超级管理员"
- **THEN** 拥有该角色的用户仍然通过 `is_admin` 标记获得所有权限，fast path 不受影响

#### Scenario: 非 admin 角色需显式分配权限
- **WHEN** 用户仅拥有 `is_admin=false` 的角色
- **THEN** `checkPermission` 基于 `role_permissions` 中的实际记录进行判断

### Requirement: is_default 标记

`is_default=true` 的角色 SHALL 在用户注册时自动分配。系统 MUST 保证全局有且仅有一个 `is_default=true` 的角色。

注册时通过查询 `SELECT * FROM roles WHERE is_default = true` 获取默认角色，**不依赖角色名称**。

#### Scenario: 新用户注册自动获得默认角色
- **WHEN** 新用户完成注册
- **THEN** 系统查询 `is_default=true` 的角色，并在 `user_roles` 表中自动插入关联

#### Scenario: 角色重命名后注册不受影响
- **WHEN** 管理员将 `is_default=true` 的角色名称从 "user" 改为 "普通用户"
- **THEN** 新用户注册时仍然自动获得该角色

#### Scenario: 禁止创建第二个默认角色
- **WHEN** 管理员尝试创建或修改一个角色使其 `is_default=true`，而当前已存在另一个 `is_default=true` 的角色
- **THEN** 系统返回 HTTP 400

### Requirement: is_system 标记

`is_system=true` 的角色 SHALL 不可删除、不可改名、不可修改 `is_admin`/`is_default` 标记。

#### Scenario: 尝试删除系统角色
- **WHEN** 管理员尝试删除 `is_system=true` 的角色
- **THEN** 系统返回 HTTP 403，错误信息提示该角色为系统保护角色

#### Scenario: 尝试修改系统角色的关键标记
- **WHEN** 管理员尝试将系统角色 "user" 的 `is_default` 改为 false
- **THEN** 系统返回 HTTP 400，拒绝修改

### Requirement: 角色继承

系统 SHALL 支持角色单父继承（`parent_id`）。权限检查时通过 `WITH RECURSIVE` CTE 沿继承链向上展开所有祖先角色的权限。

#### Scenario: 子角色继承父角色权限
- **WHEN** "moderator" 角色继承自 "user" 角色，"user" 拥有 `problem:create` 权限
- **THEN** 拥有 "moderator" 角色的用户也拥有 `problem:create` 权限

#### Scenario: 多层继承
- **WHEN** "super_moderator" 继承自 "moderator"，"moderator" 继承自 "user"
- **THEN** `getUserPermissions` 通过递归 CTE 展开三层角色的所有权限

#### Scenario: 无循环继承
- **WHEN** 管理员尝试设置角色的 `parent_id` 形成继承环
- **THEN** 系统在保存前检测并返回 HTTP 400

### Requirement: getUserPermissions 函数

系统 SHALL 提供 `getUserPermissions(userId)` 函数，通过一次递归 CTE 查询返回用户所有有效权限的 `Set<string>`。

权限格式为 `"resource:action"`（如 `"problem:create"`、`"submission:read_all"`）。

#### Scenario: 普通用户获取权限集
- **WHEN** 调用 `getUserPermissions(userId)` 且该用户仅拥有 "user" 角色（含 10 个权限）
- **THEN** 返回包含 10 个 `"resource:action"` 字符串的 Set

#### Scenario: 多角色用户获取权限并集
- **WHEN** 用户同时拥有 "user"（10 个权限）和 "problem_setter"（额外 3 个权限）两个角色
- **THEN** 返回 13 个权限的并集

### Requirement: checkPermission 函数

系统 SHALL 提供 `checkPermission(c: Context, permission)` 和 `assertPermission(c: Context, permission)` 两个工具函数。

- `checkPermission`：返回布尔值，用于条件判断
- `assertPermission`：无权限时抛出 `ForbiddenError`，用于断言
- 两者均遵循 `isAdmin` fast path → `resolvePermissions` DB fallback 的分层策略
- 两者均共享 `resolvePermissions` 的请求级缓存

若用户拥有 `is_admin=true` 的角色则直接返回 true，否则调用 `getUserPermissions` 后进行 `Set.has()` 检查。

#### Scenario: 用户拥有请求的权限
- **WHEN** `checkPermission(c, "problem:create")` 且用户拥有该权限
- **THEN** 返回 true

#### Scenario: 用户不拥有请求的权限
- **WHEN** `checkPermission(c, "problem:create_p")` 且普通用户不拥有该权限
- **THEN** 返回 false

#### Scenario: admin 用户直接放行
- **WHEN** `checkPermission(c, anyPermission)` 且用户拥有 `is_admin=true` 的角色
- **THEN** 返回 true，不执行数据库查询

### Requirement: 向前兼容 users.role 列

系统 SHALL 保留 `users.role` 列，但所有新增的授权逻辑 MUST 使用 RBAC 表（`user_roles`）进行判断。`users.role` 仅用于：
1. 现有代码的向前兼容（在逐步迁移期间）
2. JWT 的 `role` claim（用于 admin fast path）

#### Scenario: 新注册用户的 role 列与 RBAC 同步
- **WHEN** 新用户注册
- **THEN** `users.role` 设置为 user_roles 中 `is_default=true` 角色的 name 字段值

### Requirement: 系统预置角色与权限

系统 SHALL 在 seed 时创建以下预置数据：

**角色**：
- `admin`：`is_system=true`, `is_admin=true`, `is_default=false`，无 parent
- `user`：`is_system=true`, `is_admin=false`, `is_default=true`，无 parent

**权限**（22 个）：
- `problem:create`, `problem:create_p`, `problem:read`
- `problem:write_own`, `problem:write_any`
- `problem:delete_own`, `problem:delete_any`
- `problem:package_manage_own`, `problem:package_manage_any`
- `submission:create`, `submission:read_own`, `submission:read_all`
- `submission:rejudge`
- `user:read_profile`, `user:search`, `user:manage`
- `category:read`, `category:manage`
- `system:settings`, `system:judge_images`, `system:audit_logs`, `system:ip_bans`

`user` 角色 SHALL 默认拥有以下权限：`problem:create`, `problem:read`, `problem:write_own`, `problem:delete_own`, `problem:package_manage_own`, `submission:create`, `submission:read_own`, `user:read_profile`, `category:read`。
`admin` 角色 SHALL 不需要显式分配权限（`is_admin=true` 隐式全权限）。

#### Scenario: 全新部署 seed 创建预置角色
- **WHEN** `deno task seed` 在新数据库上执行
- **THEN** `roles` 表包含 admin 和 user 两个系统角色，`permissions` 表包含 22 条权限定义，`role_permissions` 表包含 user 角色的 9 条权限关联

#### Scenario: 重复 seed 幂等
- **WHEN** `deno task seed` 在已有预置数据的数据库上再次执行
- **THEN** 系统跳过已存在的角色和权限（ON CONFLICT DO NOTHING）

### Requirement: 数据迁移——现有用户角色同步

系统 SHALL 在 migration 执行时将现有 `users.role` 值同步到 `user_roles` 表：`role='admin'` 的用户关联到 admin 角色，`role='user'` 的用户关联到 user 角色。

#### Scenario: 现有管理员用户获得 RBAC 角色
- **WHEN** migration 执行时 users 表中存在 `role='admin'` 的用户
- **THEN** `user_roles` 表中插入对应行，关联该用户与 admin 角色

#### Scenario: root 用户不参与同步
- **WHEN** migration 执行
- **THEN** `id='0'` 的 root 用户不在同步范围内（root 用户不可登录，不需要 RBAC 角色）

### Requirement: contest 资源域权限

系统 SHALL 新增 `contest` 资源域的 3 个预置权限：

| resource | action | description |
|----------|--------|-------------|
| contest | create | 创建竞赛 |
| contest | manage | 管理任意竞赛（编辑、删除、参与者管理） |
| contest | participate | 参加竞赛（注册参赛） |

这些权限 SHALL 在 `PERMISSION_DEFS` 常量中定义，并在 `ensureRbacSeeds()` 中幂等初始化（`ON CONFLICT DO NOTHING`）。

竞赛公开列表查看和已结束竞赛访问 SHALL 为公开权限，无需显式 RBAC 权限。

#### Scenario: 管理员拥有 contest 权限
- **WHEN** RBAC seed 执行后，admin 角色（`is_admin=true`）的用户
- **THEN** 隐式拥有所有 contest 权限（isAdmin fast path）

#### Scenario: 普通用户注册竞赛
- **WHEN** 普通用户 POST `/api/v1/contests/:id/register`
- **THEN** 系统通过 `authMiddleware`（任何登录用户均可注册公开竞赛，无需特定权限）

### Requirement: contest 管理路由权限守卫

系统 SHALL 在 `/api/v1/admin/contests` 路由组使用 RBAC 中间件：

- `POST /contest` → `requirePermission("contest:create")` 或 `requireAdmin()`
- 其他管理端点 → `requirePermission("contest:manage")` 或 `requireAdmin()`

#### Scenario: 无 contest:create 权限的用户创建竞赛被拒
- **WHEN** 普通用户（仅拥有 contest:participate 权限）POST `/api/v1/admin/contests`
- **THEN** 系统返回 403
