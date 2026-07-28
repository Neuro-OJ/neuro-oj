## Purpose

定义 Neuro OJ 管理员角色管理规范，包括角色 CRUD、权限查询、用户角色分配以及前端角色编辑器页面。

## Requirements

### Requirement: 管理员可查看角色列表

系统 SHALL 提供 `GET /api/v1/admin/roles` 端点，返回所有角色及其关联的权限列表。

#### Scenario: 管理员获取角色列表
- **WHEN** 管理员 GET `/api/v1/admin/roles`
- **THEN** 系统返回角色数组，每个角色包含 `id`, `name`, `description`, `is_system`, `is_default`, `is_admin`, `parent_id`, `parent_name`, `permissions`（权限 ID 数组）

#### Scenario: 非管理员访问被拒绝
- **WHEN** 普通用户 GET `/api/v1/admin/roles`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可创建自定义角色

系统 SHALL 提供 `POST /api/v1/admin/roles` 端点，允许管理员创建自定义角色。请求体包含 `name`（必填）、`description`（可选）、`parent_id`（可选，父角色 UUID）、`permission_ids`（可选，权限 UUID 数组）。

新创建的角色 `is_system=false`、`is_admin=false`、`is_default=false`。

#### Scenario: 管理员创建角色成功
- **WHEN** 管理员 POST `/api/v1/admin/roles` 传入 `{ "name": "moderator", "parent_id": "<user-uuid>", "permission_ids": ["<uuid1>", "<uuid2>"] }`
- **THEN** 系统创建新角色并返回角色详情（HTTP 201），包含展开后的权限列表

#### Scenario: 角色名重复
- **WHEN** 管理员尝试创建名为 "admin" 的角色（已存在）
- **THEN** 系统返回 HTTP 409，提示角色名已存在

#### Scenario: 角色名为空
- **WHEN** 请求中 `name` 为空字符串
- **THEN** 系统返回 HTTP 400

### Requirement: 管理员可编辑角色

系统 SHALL 提供 `PUT /api/v1/admin/roles/:id` 端点，允许管理员修改角色的 `name`、`description`、`parent_id` 和 `permission_ids`。

`is_system=true` 的角色 SHALL 拒绝修改 `name`。

#### Scenario: 管理员修改自定义角色
- **WHEN** 管理员 PUT `/api/v1/admin/roles/:id` 传入新的 `name` 和 `permission_ids`
- **THEN** 系统更新角色信息并返回更新后的角色详情

#### Scenario: 尝试修改系统角色的 name
- **WHEN** 管理员尝试修改 `is_system=true` 角色的 `name`
- **THEN** 系统返回 HTTP 403

#### Scenario: 修改不存在的角色
- **WHEN** 管理员 PUT `/api/v1/admin/roles/:missing-id`
- **THEN** 系统返回 HTTP 404

### Requirement: 管理员可删除自定义角色

系统 SHALL 提供 `DELETE /api/v1/admin/roles/:id` 端点，允许管理员删除非系统角色。删除前 SHALL 检查该角色是否被其他角色继承（`parent_id` 引用），若有则拒绝删除。

#### Scenario: 管理员删除未被引用的自定义角色
- **WHEN** 管理员 DELETE `/api/v1/admin/roles/:id` 且该角色未被任何其他角色的 `parent_id` 引用
- **THEN** 系统删除该角色，级联清理 `role_permissions` 和 `user_roles`，返回 HTTP 204

#### Scenario: 尝试删除系统角色
- **WHEN** 管理员尝试删除 `is_system=true` 的角色
- **THEN** 系统返回 HTTP 403

#### Scenario: 尝试删除被继承的角色
- **WHEN** 管理员尝试删除一个角色，该角色被其他角色的 `parent_id` 引用
- **THEN** 系统返回 HTTP 400，提示该角色被其他角色继承，无法删除

### Requirement: 权限定义列表查询

系统 SHALL 提供 `GET /api/v1/admin/permissions` 端点，返回所有权限定义，按 `resource` 分组。

#### Scenario: 管理员获取权限列表
- **WHEN** 管理员 GET `/api/v1/admin/permissions`
- **THEN** 系统返回按 resource 分组的权限列表，每个权限包含 `id`, `resource`, `action`, `description`

### Requirement: 管理员可修改用户角色分配

系统 SHALL 修改 `PATCH /api/v1/admin/users/:id/role` 端点，从接受 `{ "role": "admin"|"user" }` 字符串改为接受 `{ "role_ids": ["<uuid>", ...] }` UUID 数组，支持为用户分配多个角色。

**BREAKING**：旧格式 `{ "role": "admin" }` 不再接受。

#### Scenario: 管理员为用户分配多个角色
- **WHEN** 管理员 PATCH `/api/v1/admin/users/:id/role` 传入 `{ "role_ids": ["<user-uuid>", "<moderator-uuid>"] }`
- **THEN** 系统替换该用户的所有角色关联为新列表，返回更新后的用户信息

#### Scenario: 移除用户的所有管理员角色
- **WHEN** 管理员尝试将最后一个拥有 `is_admin=true` 角色的用户的 admin 角色移除
- **THEN** 系统返回 HTTP 400，提示至少保留一个管理员

#### Scenario: 管理员不能修改自己的角色
- **WHEN** 管理员尝试修改自己的角色分配
- **THEN** 系统返回 HTTP 400

### Requirement: 角色编辑器前端页面

系统 SHALL 在 noj-ui 管理后台提供角色管理页面（`/admin/roles`），包含：
- 角色列表表格（名称、继承自、默认标记、管理员标记、是否为系统角色、操作按钮）
- 系统角色显示 🔒 图标，仅可查看不可编辑/删除
- 新建/编辑角色弹窗：名称输入框、描述输入框、父角色下拉选择器
- **管理员角色特殊处理**：若编辑的角色 `is_admin=true`，权限勾选区域**不可见**，显示提示"⚠️ 管理员角色隐式拥有所有权限，无需单独配置"
- 非管理员角色：显示按 resource 分组的权限勾选列表
  - 继承自父角色的权限 → 灰色 🔒（复选框 disabled，不可取消，title 提示"来自继承角色"）
  - 额外分配的权限 → 正常勾选（可自由增删）

#### Scenario: 管理员查看角色列表
- **WHEN** 管理员访问 `/admin/roles` 页面
- **THEN** 系统显示所有角色的列表，系统角色带有锁图标

#### Scenario: 管理员创建新角色
- **WHEN** 管理员点击"新建角色"，填写名称，选择父角色，勾选权限，点击保存
- **THEN** 新角色出现在列表中

#### Scenario: 编辑 is_admin 角色时权限区域不可见
- **WHEN** 管理员编辑 `is_admin=true` 的角色（如系统默认 "admin" 角色）
- **THEN** 权限勾选区域不渲染，显示提示文字"⚠️ 管理员角色隐式拥有所有权限，无需单独配置"

#### Scenario: 编辑时看到继承权限（锁定显示）
- **WHEN** 管理员编辑继承自 "user" 的 "moderator" 角色
- **THEN** 权限列表中将 "user" 已有的权限显示为灰色 🔒 标记、复选框 disabled 且不可取消，额外分配的权限显示为正常勾选（可自由增删）
