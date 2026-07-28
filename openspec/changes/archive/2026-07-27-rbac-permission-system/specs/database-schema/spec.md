## ADDED Requirements

### Requirement: 角色表（roles）

系统 SHALL 提供 `roles` 表存储角色定义，包含以下字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() |
| name | TEXT | NOT NULL, UNIQUE |
| description | TEXT | |
| is_system | BOOLEAN | NOT NULL, DEFAULT false |
| is_default | BOOLEAN | NOT NULL, DEFAULT false |
| is_admin | BOOLEAN | NOT NULL, DEFAULT false |
| parent_id | UUID | REFERENCES roles(id) ON DELETE SET NULL |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

系统 SHALL 预置两个角色：`admin`（is_admin=true, is_system=true）和 `user`（is_default=true, is_system=true）。

#### Scenario: 插入新角色
- **WHEN** 向 `roles` 表插入一条记录
- **THEN** 系统自动生成 UUID，is_system/is_default/is_admin 默认 false，created_at 和 updated_at 自动填充

#### Scenario: 角色名唯一约束
- **WHEN** 尝试插入与已存在记录相同 name 的角色
- **THEN** 数据库返回 UNIQUE 约束冲突

### Requirement: 权限表（permissions）

系统 SHALL 提供 `permissions` 表存储权限定义，包含以下字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() |
| resource | TEXT | NOT NULL |
| action | TEXT | NOT NULL |
| description | TEXT | |
| UNIQUE (resource, action) | | |

权限名称为 `resource:action` 格式，由应用层拼接。

系统 SHALL 预置 22 个权限定义，覆盖 problem、submission、user、category、system 五个资源域。

#### Scenario: 插入权限定义
- **WHEN** seed 脚本插入 `resource='problem'`, `action='create'`, `description='创建题目'`
- **THEN** 系统在 permissions 表中创建对应记录

#### Scenario: 资源+操作唯一约束
- **WHEN** 尝试插入与已存在记录相同的 (resource, action) 组合
- **THEN** 数据库返回 UNIQUE 约束冲突

### Requirement: 角色权限关联表（role_permissions）

系统 SHALL 提供 `role_permissions` 表：

| 字段 | 类型 | 约束 |
|------|------|------|
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| permission_id | UUID | REFERENCES permissions(id) ON DELETE CASCADE |
| PRIMARY KEY (role_id, permission_id) | | |

#### Scenario: 级联删除角色时清理关联
- **WHEN** 删除一个角色
- **THEN** `role_permissions` 中该角色的所有权限关联被级联删除

### Requirement: 用户角色关联表（user_roles）

系统 SHALL 提供 `user_roles` 表：

| 字段 | 类型 | 约束 |
|------|------|------|
| user_id | UUID | REFERENCES users(id) ON DELETE CASCADE |
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| PRIMARY KEY (user_id, role_id) | | |

#### Scenario: 级联删除用户时清理关联
- **WHEN** 删除一个用户
- **THEN** `user_roles` 中该用户的所有角色关联被级联删除

#### Scenario: 级联删除角色时清理用户关联
- **WHEN** 删除一个非系统角色
- **THEN** `user_roles` 中所有关联该角色的行被级联删除

### Requirement: users.role 列保留

`users.role` 列 SHALL 保留不变（`TEXT NOT NULL DEFAULT 'user'`），但标记为 deprecated。新代码 SHALL 通过 `user_roles` 表判断权限，`users.role` 仅作为向前兼容字段和 JWT admin fast path 的值来源。

注册时，`users.role` SHALL 设置为 `is_default=true` 角色的 `name`。

#### Scenario: 新用户注册时 role 列同步
- **WHEN** 新用户注册，默认角色名称为 "user"
- **THEN** `users.role` 设置为 "user"，与 `user_roles` 关联一致
