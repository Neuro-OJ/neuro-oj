## Purpose

定义 Neuro OJ 管理员权限系统规范，包括管理中间件、角色提升 API
及种子脚本初始化。 API 路径前缀为 `/api/v1/admin`，默认角色为 `user` 和 `admin`
两级。

## Requirements

### Requirement: Root 系统用户自动创建

系统 SHALL 在启动时自动创建 `id='0'` 的 root 用户（admin 角色、随机密码、不可登录）。

#### Scenario: 首次启动创建 root
- **WHEN** noj-core 首次启动且 users 表中不存在 id='0' 的用户
- **THEN** 系统自动创建 root 用户，角色为 admin，密码为随机 UUID，bio 为"系统根用户"

#### Scenario: root 用户不在用户列表中显示
- **WHEN** 管理员查询用户列表
- **THEN** 列表中不包含 id='0' 的 root 用户

### Requirement: 管理路由统一组织

系统 SHALL 将所有 admin 端点集中到 `routes/admin.ts` 文件中统一管理，各功能模块在 admin.ts 内按 domain 分组，统一通过路由组级 `authMiddleware` + `adminMiddleware` 保护。

#### Scenario: 管理员访问统一后的管理端点
- **WHEN** 管理员访问所有 `/api/v1/admin/*` 端点
- **THEN** 系统响应与重构前一致，无破坏性变更

#### Scenario: root 用户不可登录
- **WHEN** 尝试使用 root 用户的随机密码登录
- **THEN** 因 root 密码为随机 UUID 且机制上不对外暴露，登录失败
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
- **WHEN** 管理员尝试将最后一个权限集中包含 `admin:full_access` 的用户的 admin 角色移除
- **THEN** 系统返回 HTTP 400，提示必须保留至少一个管理员

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task init:system` 执行时执行 `ensureRootUser()`，并在 `deno task bootstrap:admin` / `deno task dev-setup` 执行时执行 `ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"（`user_roles` 关联角色的权限集中含 `admin:full_access` 的用户，且 `users.id != '0'`）时自动创建一个临时管理员账号（`username='admin'`, `email='admin@noj.local'`, 24 字符 base64url 随机密码），并设置 `must_change_password=true`，终端以醒目格式打印临时凭证。

管理员创建后 SHALL 将其关联到拥有 `admin:full_access` 权限的角色（如预置的 "admin" 角色）。

开发编排工具 SHALL 在 `devtool.sh start core`（包括完整 `devtool.sh start`）启动后端前执行管理员引导。该引导 MUST 复用 `.env` 中的 `ADMIN_EMAIL` / `ADMIN_PASS`：账号不存在时创建并赋予管理员权限，已存在可登录管理员时不得覆盖其密码；引导失败时不得启动后端进程。

#### Scenario: 全新部署自动创建引导管理员

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）在全新数据库上执行，且不存在可登录 admin（通过 `user_roles` + `admin:full_access` 权限判断）
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，并将其关联到 admin 角色，在终端打印临时凭证（含强制改密提醒）

#### Scenario: 已存在可登录 admin 时跳过

- **WHEN** `deno task dev-setup`（或 `deno task bootstrap:admin`）执行时已存在拥有 `admin:full_access` 权限的用户
- **THEN** 系统跳过引导管理员创建，不打印临时凭证

#### Scenario: 开发编排启动时创建配置管理员

- **WHEN** 开发者执行 `devtool.sh start core`，数据库中不存在 `.env` 的 `ADMIN_EMAIL` 对应账号
- **THEN** 工具在启动后端前以 `ADMIN_PASS` 创建该账号并赋予管理员权限，且开发模式下不强制首次改密

#### Scenario: 开发编排不覆盖既有管理员密码

- **WHEN** 开发者执行 `devtool.sh start core`，且数据库中已有具备管理员权限的 `ADMIN_EMAIL` 对应账号
- **THEN** 工具继续启动后端且不修改该账号的密码

### Requirement: 强制首次改密（管理员）

系统 SHALL 在 `must_change_password=true` 时拒绝该用户访问除白名单外的所有受保护路径，强制其先修改密码。

#### Scenario: 未改密用户访问受保护端点

- **WHEN** `must_change_password=true` 的用户调用 `/api/v1/submissions` 等非白名单受保护端点
- **THEN** 系统返回 HTTP 403，错误消息 `"请先修改密码"`，`code` 为 `PASSWORD_CHANGE_REQUIRED`

#### Scenario: 未改密用户访问白名单端点

- **WHEN** `must_change_password=true` 的用户调用 `/api/v1/auth/change-password`、`/api/v1/auth/me` 或 `/api/v1/auth/logout`
- **THEN** 系统正常处理请求

#### Scenario: 改密成功后解除限制

- **WHEN** 用户成功调用 `POST /api/v1/auth/change-password`
- **THEN** 系统更新 `password_hash` 并设置 `must_change_password=false`，后续签发的 JWT 不再携带强制改密 claim

### Requirement: 引导管理员临时凭证打印

`ensureBootstrapAdmin()` 创建管理员后 MUST 在终端以醒目格式（带 `⚠` 图标）打印 username、email、password 三个字段，便于首次部署者立即登录。打印格式：

```
⚠ 已创建临时引导管理员（首次登录后必须修改密码）：
  username: admin
  email:    admin@noj.local
  password: <24字符 base64url>
```

#### Scenario: 凭证打印格式

- **WHEN** `ensureBootstrapAdmin()` 成功插入临时管理员
- **THEN** 终端输出包含上述三行的提示块

### Requirement: 管理员可查看所有用户提交

系统 SHALL 提供 `GET /api/v1/admin/submissions`
端点，允许管理员查看所有用户的提交列表。

此端点 MUST 依次通过 `authMiddleware` 和 `adminMiddleware`
保护。支持与用户提交列表接口相同的分页和筛选参数，额外支持 `user_id`
查询参数按用户筛选。

详细规范见 `submission-list-api` spec 中「管理员查询所有用户提交」需求。

#### Scenario: 管理员成功查询

- **WHEN** 管理员 GET `/api/v1/admin/submissions`
- **THEN** 系统返回提交列表和分页信息

#### Scenario: 普通用户被拒绝

- **WHEN** 普通用户（role=user）携带有效 JWT 访问 `/api/v1/admin/submissions`
- **THEN** 系统返回 403，错误消息 `"需要管理员权限"`

### Requirement: 管理员可查看仪表盘统计数据

系统 SHALL 提供 `GET /api/v1/admin/dashboard/stats` 端点，返回平台关键统计指标。

详细规范见 `admin-dashboard` spec。

#### Scenario: 管理员成功获取统计数据

- **WHEN** 已登录管理员 GET `/api/v1/admin/dashboard/stats`
- **THEN** 系统返回平台统计指标

### Requirement: 管理员可查看任意提交详情

系统 SHALL 提供 `GET /api/v1/admin/submissions/:id` 端点，允许管理员查看任意提交的完整详情。

详细规范见 `admin-submission-management` spec。

#### Scenario: 管理员成功查看提交详情

- **WHEN** 管理员 GET `/api/v1/admin/submissions/:id`
- **THEN** 系统返回提交完整详情

### Requirement: 管理员可删除提交记录

系统 SHALL 提供 `DELETE /api/v1/admin/submissions/:id` 端点，允许管理员删除提交记录。

详细规范见 `admin-submission-management` spec。

#### Scenario: 管理员成功删除提交

- **WHEN** 管理员 DELETE `/api/v1/admin/submissions/:id`
- **THEN** 系统返回 HTTP 204

### Requirement: requirePermission 中间件

系统 SHALL 提供 `requirePermission(permission: string)` 中间件工厂函数，用于需要细粒度权限检查的路由。

中间件逻辑：
1. 调用 `resolvePermissions(c)` 获取用户权限 `Set<string>`
2. 若权限集包含 `admin:full_access` → `next()`（全权限放行）
3. 否则若 `Set.has(permission)` → `next()`，否则抛出 `ForbiddenError("权限不足")`

`resolvePermissions(c)` SHALL 实现请求级缓存：首次调用查询 DB 并写入 `c.set("userPerms", ...)`，后续调用直接返回缓存值，**同一请求内多权限检查不产生额外 DB 查询**。

#### Scenario: admin 用户访问 requirePermission 保护的路由
- **WHEN** 权限集包含 `admin:full_access` 的用户访问受 `requirePermission("problem:create_p")` 保护的路由
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
- 判定规则：权限集包含 `admin:full_access` 时直接放行，否则 `Set.has(permission)`
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
