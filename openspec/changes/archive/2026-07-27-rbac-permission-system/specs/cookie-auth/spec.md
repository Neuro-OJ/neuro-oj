## MODIFIED Requirements

### Requirement: session cookie 内容规范

`noj:session` cookie SHALL 包含以下 JSON 序列化信息：`userId`、`username`、`role`、`isAdmin`、`email`。

`role` 字段 SHALL 为用户关联的 `is_admin=true` 角色的名称（若存在），否则为 `is_default=true` 角色的名称。`isAdmin` 字段 SHALL 为用户是否拥有 `is_admin=true` 的角色（布尔值）。

SHALL NOT 包含 token 或任何敏感凭证。

#### Scenario: admin 角色的 session cookie
- **WHEN** 用户登录且拥有 `is_admin=true` 的角色
- **THEN** `noj:session` cookie 的 `role` 字段为该角色名称，`isAdmin` 为 `true`

#### Scenario: 多角色用户的 session cookie
- **WHEN** 用户登录且同时拥有 "user" 和 "moderator" 两个角色（均非 is_admin=true）
- **THEN** `noj:session` cookie 的 `role` 字段为 `is_default=true` 的角色名称，`isAdmin` 为 `false`

### Requirement: 登录时从 RBAC 表读取角色信息

用户登录时，系统 SHALL 从 `user_roles` + `roles` 表联合查询用户的角色信息，而非仅依赖 `users.role` 列。

JWT SHALL 包含 `is_admin` 布尔 claim，由 `roleRows.some(r => r.is_admin)` 推导。`role` claim SHALL 设置为 `is_admin=true` 的角色名称（若存在），否则为 `is_default=true` 的角色名称。

权限判断 SHALL 使用 `is_admin` claim 而非角色名称——角色名称仅用于展示和向前兼容。

#### Scenario: 管理员登录时 JWT 包含 is_admin
- **WHEN** 拥有 `is_admin=true` 角色的用户登录
- **THEN** 签发的 JWT 中 `is_admin` claim 为 `true`，`role` claim 为该角色名称

#### Scenario: 普通用户登录时 JWT is_admin 为 false
- **WHEN** 仅拥有 `is_admin=false` 角色的用户登录
- **THEN** 签发的 JWT 中 `is_admin` claim 为 `false`，`role` claim 为 `is_default=true` 的角色名称
