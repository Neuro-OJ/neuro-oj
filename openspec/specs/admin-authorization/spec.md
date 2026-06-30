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

系统 SHOULD 将所有 admin 端点集中到 `routes/admin.ts` 文件中统一管理，各功能模块在 admin.ts 内按 domain 分组，统一通过路由组级 `authMiddleware` + `adminMiddleware` 保护。

#### Scenario: 管理员访问统一后的管理端点
- **WHEN** 管理员访问所有 `/api/v1/admin/*` 端点
- **THEN** 系统响应与重构前一致，无破坏性变更

#### Scenario: root 用户不可登录
- **WHEN** 尝试使用 root 用户的随机密码登录
- **THEN** 因 root 密码为随机 UUID 且机制上不对外暴露，登录失败
### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `adminMiddleware`，用于保护非题目类的管理端点。
题目 CRUD 不再依赖 adminMiddleware，改为服务层根据 type+owner 进行权限判断。

所有管理端点（除已使用自有权限模型的题目 CRUD 外）MUST 依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 普通用户访问管理端点

- **WHEN** 已登录但角色为 `user` 的用户携带有效 JWT 调用管理员端点
- **THEN** 系统返回 HTTP 403，错误信息为 "需要管理员权限"

#### Scenario: 未登录用户访问管理端点

- **WHEN** 未携带 JWT 的用户调用管理员端点
- **THEN** 系统在 `adminMiddleware` 之前由 `authMiddleware` 返回 HTTP 401

#### Scenario: 题目端点改用服务层权限

- **WHEN** 普通用户访问 `PUT /api/v1/problems/:id`
- **THEN** 不再经过 adminMiddleware，由服务层根据 type+owner 判断

### Requirement: 管理员可提升其他用户为管理员

系统 SHALL 提供
`PATCH /api/v1/admin/users/:id/role`，允许现有管理员将指定用户的角色修改为
`admin` 或 `user`。

#### Scenario: 管理员成功提升用户

- **WHEN** 管理员调用 `PATCH /api/v1/admin/users/:id/role` 并传入
  `{ "role": "admin" }`
- **THEN** 系统更新该用户角色并返回更新后的用户信息

#### Scenario: 非管理员调用提升接口

- **WHEN** 普通用户调用 `PATCH /api/v1/admin/users/:id/role`
- **THEN** 系统返回 HTTP 403

#### Scenario: 提升不存在的用户

- **WHEN** 管理员调用 `PATCH /api/v1/admin/users/:missing-id/role`
- **THEN** 系统返回 HTTP 404

#### Scenario: 传入非法角色值

- **WHEN** 管理员调用 `PATCH /api/v1/admin/users/:id/role` 并传入
  `{ "role": "superuser" }`
- **THEN** 系统返回 HTTP 400，提示角色值非法

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task seed` 执行时，依次执行 `ensureRootUser()` 和 `ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"（`role='admin' AND id != '0'`）时自动创建一个临时管理员账号（`username='admin'`, `email='admin@noj.local'`, 24 字符 base64url 随机密码），并设置 `must_change_password=true`，终端以醒目格式打印临时凭证。

`ensureAdminFromEnv()` 在 `ADMIN_EMAIL` 已设置时仍按既有逻辑提升指定用户为 admin；若该用户不存在则打印警告但**不**回退到创建临时管理员（避免覆盖运维人员的明确意图）。

#### Scenario: 全新部署自动创建引导管理员

- **WHEN** `deno task seed` 在全新数据库上执行，且不存在可登录 admin
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，并在终端打印临时凭证（含强制改密提醒）

#### Scenario: 已存在可登录 admin 时跳过

- **WHEN** `deno task seed` 执行时 users 表中已存在至少一个 `role='admin' AND id != '0'` 的用户
- **THEN** 系统跳过引导管理员创建，不打印临时凭证

#### Scenario: 已设置 ADMIN_EMAIL 时使用 env 账户

- **WHEN** 环境变量 `ADMIN_EMAIL=ops@example.com` 且对应用户已注册
- **THEN** 系统沿用既有 `ensureAdminFromEnv()` 逻辑提升该用户为 admin，不创建临时引导管理员

#### Scenario: ADMIN_EMAIL 对应用户不存在

- **WHEN** 环境变量 `ADMIN_EMAIL=missing@example.com` 且该用户未注册
- **THEN** 系统打印警告，但**不**自动创建引导管理员（保持运维人员的明确意图优先）

#### Scenario: 重复执行 seed 幂等

- **WHEN** 已存在 `must_change_password=true` 的临时 admin，再次执行 `deno task seed`
- **THEN** 系统跳过引导管理员创建（按"已存在可登录 admin"分支）

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
