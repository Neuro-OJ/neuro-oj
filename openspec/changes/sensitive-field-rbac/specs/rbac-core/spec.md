## MODIFIED Requirements

### Requirement: 系统预置角色与权限

系统 SHALL 在 `deno task init:system` 时创建以下预置数据：

**角色**：
- `admin`：`is_system=true`, `is_admin=true`, `is_default=false`，无 parent
- `user`：`is_system=true`, `is_admin=false`, `is_default=true`，无 parent

**权限**（核心权限 24 个，另含 contest/community 等资源域权限；完整清单以 `PERMISSION_DEFS` 为准）：
- `problem:create`, `problem:create_p`, `problem:read`
- `problem:write_own`, `problem:write_any`
- `problem:delete_own`, `problem:delete_any`
- `problem:package_manage_own`, `problem:package_manage_any`
- `problem:field_evaluator_command`（题目敏感字段：evaluator 评测命令）
- `problem:field_evaluator_network`（题目敏感字段：evaluator 联网开关）
- `submission:create`, `submission:read_own`, `submission:read_all`
- `submission:rejudge`
- `user:read_profile`, `user:search`, `user:manage`
- `category:read`, `category:manage`
- `system:settings`, `system:judge_images`, `system:audit_logs`, `system:ip_bans`

`user` 角色 SHALL 默认拥有以下权限：`problem:create`, `problem:read`, `problem:write_own`, `problem:delete_own`, `problem:package_manage_own`, `problem:field_evaluator_command`, `problem:field_evaluator_network`, `submission:create`, `submission:read_own`, `user:read_profile`, `category:read`。
`admin` 角色 SHALL 不需要显式分配权限（`is_admin=true` 隐式全权限）。

#### Scenario: 全新部署 init:system 创建预置角色
- **WHEN** `deno task init:system` 在新数据库上执行
- **THEN** `roles` 表包含 admin 和 user 两个系统角色，`permissions` 表包含 24 条权限定义，`role_permissions` 表包含 user 角色的 11 条权限关联（含两个敏感字段权限项）

#### Scenario: 重复 init:system 幂等
- **WHEN** `deno task init:system` 在已有预置数据的数据库上再次执行
- **THEN** 系统跳过已存在的角色和权限（ON CONFLICT DO NOTHING）

#### Scenario: 存量部署自动补齐敏感字段权限项
- **WHEN** 已有数据库启动执行 `ensureRbacSeeds()`
- **THEN** `permissions` 表新增 `problem:field_evaluator_command` 与 `problem:field_evaluator_network`，`role_permissions` 表为 user 角色补齐对应关联，已有授权不变
