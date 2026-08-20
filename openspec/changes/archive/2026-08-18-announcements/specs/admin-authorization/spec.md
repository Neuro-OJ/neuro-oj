## ADDED Requirements

### Requirement: 公告管理权限注册

系统 SHALL 在 `PERMISSION_DEFS`（`src/types/index.ts`）注册公告管理权限：

- `announcement:manage`（resource=`announcement`, action=`manage`，description「管理公告」）

`ensurePermissions()`（`seed-rbac.ts`）SHALL 幂等插入该权限（ON CONFLICT DO NOTHING），admin 角色的 `ADMIN_DEFAULT_PERMISSIONS` SHALL 包含该项。`admin:full_access` 通配放行语义 SHALL 适用于该权限（admin 不受收紧影响）。

公告管理端点（`/api/v1/admin/announcements*`）SHALL 在 handler 内调用 `assertPermission(c, "announcement:manage")` 执行细粒度检查，无权限返回 403。

#### Scenario: 权限种子补齐

- **WHEN** 已有数据库上启动并执行 `ensureRbacSeeds()`
- **THEN** `permissions` 表存在 `announcement:manage` 记录（幂等，不重复）

#### Scenario: admin 隐式拥有公告权限

- **WHEN** 持有 `admin:full_access` 的用户调用公告管理端点
- **THEN** 权限检查通过（通配放行），无需显式分配 `announcement:manage`

#### Scenario: 无权限用户被拒

- **WHEN** 无 `admin:full_access` 且无 `announcement:manage` 的用户调用公告管理端点
- **THEN** 系统返回 HTTP 403
