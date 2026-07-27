## MODIFIED Requirements

### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `requireAdmin()` 中间件，用于保护管理端点。`requireAdmin()` 基于 JWT 的 `is_admin` 布尔 claim 判断，**不查询数据库、不依赖角色名称**。

非管理员访问时 SHALL 返回 HTTP 403，错误信息为 "需要管理员权限"。

所有管理端点 MUST 依次通过 `authMiddleware` 和 `requireAdmin()` 保护。

题目 CRUD 不再依赖 `requireAdmin()`，改为使用 `requirePermission()` 中间件进行细粒度权限判断。

#### Scenario: 普通用户访问管理端点
- **WHEN** 已登录但 JWT `is_admin=false` 的用户调用管理员端点
- **THEN** 系统返回 HTTP 403，错误信息为 "需要管理员权限"

#### Scenario: 未登录用户访问管理端点
- **WHEN** 未携带 JWT 的用户调用管理员端点
- **THEN** 系统在 `requireAdmin()` 之前由 `authMiddleware` 返回 HTTP 401

#### Scenario: 题目端点使用 requirePermission
- **WHEN** 普通用户访问 `PUT /api/v1/problems/:id`
- **THEN** 不再经过 `requireAdmin()`，由 `requirePermission("problem:write_own")` 或服务层 `checkPermission` 判断

### Requirement: 管理员可修改用户角色分配

系统 SHALL 提供 `PATCH /api/v1/admin/users/:id/role`，允许管理员修改指定用户的角色分配。

请求体 SHALL 接受 `{ "role_ids": ["<uuid>", ...] }`（UUID 数组），替换用户的所有角色关联。

**BREAKING**：不再接受旧格式 `{ "role": "admin"|"user" }`。

#### Scenario: 管理员为用户分配多个角色
- **WHEN** 管理员调用 `PATCH /api/v1/admin/users/:id/role` 并传入 `{ "role_ids": ["<user-uuid>", "<moderator-uuid>"] }`
- **THEN** 系统替换该用户的所有角色关联为新列表，返回更新后的用户信息

#### Scenario: 非管理员调用提升接口
- **WHEN** 普通用户调用 `PATCH /api/v1/admin/users/:id/role`
- **THEN** 系统返回 HTTP 403

#### Scenario: 提升不存在的用户
- **WHEN** 管理员调用 `PATCH /api/v1/admin/users/:missing-id/role`
- **THEN** 系统返回 HTTP 404

#### Scenario: 传入不存在的角色 ID
- **WHEN** 管理员传入 `{ "role_ids": ["<non-existent-uuid>"] }`
- **THEN** 系统返回 HTTP 400，提示角色 ID 无效

#### Scenario: 禁止移除最后一个 admin
- **WHEN** 管理员尝试将最后一个拥有 `is_admin=true` 角色的用户的 admin 角色移除
- **THEN** 系统返回 HTTP 400，提示必须保留至少一个管理员

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task seed` 执行时，依次执行 `ensureRootUser()` 和 `ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"（`user_roles` 表中关联了 `is_admin=true` 角色的用户，且 `users.id != '0'`）时自动创建一个临时管理员账号。

#### Scenario: 全新部署自动创建引导管理员
- **WHEN** `deno task seed` 在全新数据库上执行，且不存在可登录 admin（通过 `user_roles` + `roles.is_admin=true` 判断）
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，并将其关联到 admin 角色

#### Scenario: 已存在可登录 admin 时跳过
- **WHEN** `deno task seed` 执行时 `user_roles` 表中已存在关联 `is_admin=true` 角色的用户
- **THEN** 系统跳过引导管理员创建

## ADDED Requirements

### Requirement: requirePermission 中间件

系统 SHALL 提供 `requirePermission(permission: string)` 中间件工厂函数，用于需要细粒度权限检查的路由。

中间件逻辑：
1. 若 `c.var.isAdmin === true` → `next()`（JWT fast path，零 DB 查询）
2. 否则调用 `resolvePermissions(c)` 获取用户权限 `Set<string>` → 若 `Set.has(permission)` 则 `next()`，否则抛出 `ForbiddenError("权限不足")`

`resolvePermissions(c)` SHALL 实现请求级缓存：首次调用查询 DB 并写入 `c.set("userPerms", ...)`，后续调用直接返回缓存值，**同一请求内多权限检查不产生额外 DB 查询**。

#### Scenario: admin 用户访问 requirePermission 保护的路由
- **WHEN** `is_admin=true` 的用户访问受 `requirePermission("problem:create_p")` 保护的路由
- **THEN** 直接放行，不触发数据库查询

#### Scenario: 有权限的普通用户访问
- **WHEN** 拥有 `problem:create` 权限的用户访问受 `requirePermission("problem:create")` 保护的路由
- **THEN** 通过权限检查，正常处理

#### Scenario: 无权限用户被拒绝
- **WHEN** 不拥有 `problem:create_p` 权限的用户访问受 `requirePermission("problem:create_p")` 保护的路由
- **THEN** 系统返回 HTTP 403，错误信息 "权限不足"

### Requirement: checkPermission 工具函数

系统 SHALL 提供 `checkPermission(c: Context, permission: string): Promise<boolean>` 和 `assertPermission(c: Context, permission: string): Promise<void>` 两个工具函数，供 handler 和 service 层内部使用。

- `checkPermission`：返回布尔值，用于条件判断
- `assertPermission`：无权限时抛出 `ForbiddenError`，用于断言
- 两者均遵循 `isAdmin` fast path → `resolvePermissions` DB fallback 的分层策略
- 两者均共享 `resolvePermissions` 的请求级缓存

#### Scenario: handler 内条件判断
- **WHEN** handler 中调用 `if (await checkPermission(c, "problem:create_p")) { ... } else { ... }`
- **THEN** 根据用户权限返回 true 或 false

#### Scenario: service 层断言
- **WHEN** service 函数调用 `await assertPermission(c, "problem:delete_any")` 且用户无此权限
- **THEN** 抛出 `ForbiddenError("权限不足")`

### Requirement: 服务层权限检查迁移

系统 SHALL 将 `problems-crud.ts`、`support-package.ts`、`submissions-crud.ts`、`search.ts` 中的硬编码 `userRole === "admin"` 逐步替换为 `checkPermission()` / `assertPermission()` 调用。

迁移期间，`checkPermission` 和硬编码检查可共存。硬编码检查作为过渡期安全网，后续收紧。

#### Scenario: 服务层使用 checkPermission 检查创建 P 型题
- **WHEN** 用户调用 `createProblem` 且题目类型为 "P"
- **THEN** 服务层调用 `await assertPermission(c, "problem:create_p")` 进行检查，而非比较 `userRole === "admin"`
