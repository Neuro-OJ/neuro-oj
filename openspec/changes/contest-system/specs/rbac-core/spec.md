## ADDED Requirements

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
