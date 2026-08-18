## MODIFIED Requirements

### Requirement: 系统预置角色与权限

系统 SHALL 在 `deno task init:system` 时创建以下预置数据：

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
- `tag:read`, `tag:manage`
- `system:settings`, `system:judge_images`, `system:audit_logs`, `system:ip_bans`

`user` 角色 SHALL 默认拥有以下权限：`problem:create`, `problem:read`, `problem:write_own`, `problem:delete_own`, `problem:package_manage_own`, `submission:create`, `submission:read_own`, `user:read_profile`, `tag:read`。
`admin` 角色 SHALL 不需要显式分配权限（`is_admin=true` 隐式全权限）。

标签管控权限 `tag:manage` SHALL 默认不授予任何角色（仅 admin 隐式拥有），但仍作为预置权限存在于 `permissions` 表中，运营者可经角色管理将其授予自定义角色以满足自身管控需求。

#### Scenario: 全新部署 init:system 创建预置角色
- **WHEN** `deno task init:system` 在新数据库上执行
- **THEN** `roles` 表包含 admin 和 user 两个系统角色，`permissions` 表包含 22 条权限定义，`role_permissions` 表包含 user 角色的 9 条权限关联

#### Scenario: 重复 init:system 幂等
- **WHEN** `deno task init:system` 在已有预置数据的数据库上再次执行
- **THEN** 系统跳过已存在的角色和权限（ON CONFLICT DO NOTHING）

#### Scenario: 旧分类权限被清理
- **WHEN** 迁移在已存在 `category:read`/`category:manage` 权限的数据库上执行
- **THEN** 这两条权限及其角色关联被删除，替换为 `tag:read`/`tag:manage`

#### Scenario: tag:manage 默认仅 admin

- **WHEN** 全新部署执行 `init:system`
- **THEN** `role_permissions` 中不存在任何角色与 `tag:manage` 的关联（仅 admin 经 `is_admin=true` 隐式拥有）

#### Scenario: 运营者可将 tag:manage 授予自定义角色

- **WHEN** 运营者创建自定义角色并通过角色权限管理授予 `tag:manage`
- **THEN** 该角色用户获得标签写接口调用权限，`user` 默认角色不受影响
