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

`is_system=true` 的角色 SHALL 不可删除、不可改名、不可修改 `is_default` 标记。

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

**权限**（共 42 个，覆盖 problem/submission/user/tag/contest/community/system 资源域；完整清单以 `PERMISSION_DEFS` 为准）：
- `problem:create`, `problem:create_p`, `problem:read`
- `problem:write_own`, `problem:write_any`
- `problem:delete_own`, `problem:delete_any`
- `problem:package_manage_own`, `problem:package_manage_any`
- `problem:field_evaluator_command`（题目敏感字段：evaluator 评测命令）
- `problem:field_evaluator_network`（题目敏感字段：evaluator 联网开关）
- `submission:create`, `submission:read_own`, `submission:read_all`
- `submission:rejudge`
- `user:read_profile`, `user:search`, `user:manage`
- `tag:read`, `tag:manage`
- `contest:participate` 及 `community:*` 域权限（read / create_solution / create_discussion / create_moment / comment / react / follow / report）
- `system:settings`, `system:judge_images`, `system:audit_logs`, `system:ip_bans`
- `admin:full_access`（管理员通配权限）

`user` 角色 SHALL 默认拥有以下权限（`USER_DEFAULT_PERMISSIONS`，18 项）：`problem:create`, `problem:read`, `problem:write_own`, `problem:delete_own`, `problem:package_manage_own`, `submission:create`, `submission:read_own`, `user:read_profile`, `tag:read`, `contest:participate`, `community:read`, `community:create_solution`, `community:create_discussion`, `community:create_moment`, `community:comment`, `community:react`, `community:follow`, `community:report`。
`admin` 角色 SHALL 通过 `admin:full_access` 通配权限放行全部操作（无需逐项分配权限）。

标签管控权限 `tag:manage` SHALL 默认不授予任何角色（仅 admin 隐式拥有），但仍作为预置权限存在于 `permissions` 表中，运营者可经角色管理将其授予自定义角色以满足自身管控需求。

#### Scenario: 全新部署 init:system 创建预置角色
- **WHEN** `deno task init:system` 在新数据库上执行
- **THEN** `roles` 表包含 admin 和 user 两个系统角色，`permissions` 表包含 42 条权限定义（`PERMISSION_DEFS` 全量），`role_permissions` 表包含 user 角色的 20 条权限关联（18 条常规默认授权 + 2 条敏感字段一次性授权）

#### Scenario: 重复 init:system 幂等
- **WHEN** `deno task init:system` 在已有预置数据的数据库上再次执行
- **THEN** 系统跳过已存在的角色和权限（ON CONFLICT DO NOTHING）

#### Scenario: 存量部署自动补齐敏感字段权限项
- **WHEN** 已有数据库启动执行 `ensureRbacSeeds()`
- **THEN** `permissions` 表新增 `problem:field_evaluator_command` 与 `problem:field_evaluator_network`，`role_permissions` 表为 user 角色补齐对应关联，已有授权不变

#### Scenario: 旧分类权限被清理
- **WHEN** 迁移在已存在 `category:read`/`category:manage` 权限的数据库上执行
- **THEN** 这两条权限及其角色关联被删除，替换为 `tag:read`/`tag:manage`

#### Scenario: tag:manage 默认仅 admin

- **WHEN** 全新部署执行 `init:system`
- **THEN** `role_permissions` 中不存在任何角色与 `tag:manage` 的关联（仅 admin 经 `admin:full_access` 隐式拥有）

#### Scenario: 运营者可将 tag:manage 授予自定义角色

- **WHEN** 运营者创建自定义角色并通过角色权限管理授予 `tag:manage`
- **THEN** 该角色用户获得标签写接口调用权限，`user` 默认角色不受影响

### Requirement: 数据迁移——现有用户角色同步

系统 SHALL 在 `deno task init:system` / `dev-setup` 执行时，为尚无任何 `user_roles` 关联的存量用户补齐默认 `user` 角色关联（`users.role` 列已删除，迁移不得再依赖该列）。

#### Scenario: 无角色关联的存量用户获得默认角色

- **WHEN** 初始化脚本执行时存在无 `user_roles` 关联的用户
- **THEN** `user_roles` 表插入该用户与 user 角色的关联

#### Scenario: root 用户不参与同步

- **WHEN** 初始化脚本执行
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
- **WHEN** RBAC seed 执行后，admin 角色（权限集含 `admin:full_access`）的用户
- **THEN** 隐式拥有所有 contest 权限（全权限放行）

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
