## MODIFIED Requirements

### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `requireAdmin()` 中间件，用于保护管理端点。`requireAdmin()` 基于实时权限查询判断：通过 `resolvePermissions(c)`（请求级缓存）检查权限集是否包含 `admin:full_access`，**不依赖 JWT 中的 is_admin claim、不依赖角色名称**。

非管理员访问时 SHALL 返回 HTTP 403，错误信息为 "需要管理员权限"。

所有管理端点 MUST 依次通过 `authMiddleware` 和 `requireAdmin()` 保护。

题目 CRUD 不再依赖 `requireAdmin()`，改为使用 `requirePermission()` 中间件进行细粒度权限判断。

#### Scenario: 普通用户访问管理端点

- **WHEN** 已登录但权限集不含 `admin:full_access` 的用户调用管理员端点
- **THEN** 系统返回 HTTP 403，错误信息为 "需要管理员权限"

#### Scenario: 未登录用户访问管理端点

- **WHEN** 未携带 JWT 的用户调用管理员端点
- **THEN** 系统在 `requireAdmin()` 之前由 `authMiddleware` 返回 HTTP 401

#### Scenario: 题目端点使用 requirePermission

- **WHEN** 普通用户访问 `PUT /api/v1/problems/:id`
- **THEN** 不再经过 `requireAdmin()`，由 `requirePermission("problem:write_own")` 或服务层 `checkPermission` 判断

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task init:system` 执行时执行 `ensureRootUser()`，并在 `deno task bootstrap:admin` / `deno task dev-setup` 执行时执行 `ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"（`user_roles` 关联角色的权限集中含 `admin:full_access` 的用户，且 `users.id != '0'`）时自动创建一个临时管理员账号（`username='admin'`, `email='admin@noj.local'`, 24 字符 base64url 随机密码），并设置 `must_change_password=true`，终端以醒目格式打印临时凭证。

管理员创建后 SHALL 将其关联到拥有 `admin:full_access` 权限的角色（如预置的 "admin" 角色）。

#### Scenario: 全新部署自动创建引导管理员

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）在全新数据库上执行，且不存在可登录 admin（通过 `user_roles` + `admin:full_access` 权限判断）
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，并将其关联到 admin 角色，在终端打印临时凭证（含强制改密提醒）

#### Scenario: 已存在可登录 admin 时跳过

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）执行时已存在拥有 `admin:full_access` 权限的用户
- **THEN** 系统跳过引导管理员创建，不打印临时凭证
