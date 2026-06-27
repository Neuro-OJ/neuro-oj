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

系统 SHALL 在 `deno task seed` 执行时，根据环境变量 `ADMIN_EMAIL`
将对应已注册用户的角色设为 `admin`；若该邮箱用户不存在则跳过并打印警告。

#### Scenario: 种子脚本提升已注册用户

- **WHEN** 环境变量 `ADMIN_EMAIL=admin@example.com` 且该邮箱已注册
- **THEN** 种子脚本执行后该用户角色为 `admin`

#### Scenario: 种子脚本未配置 ADMIN_EMAIL

- **WHEN** 环境变量 `ADMIN_EMAIL` 未设置
- **THEN** 种子脚本不执行管理员提升操作，正常完成

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
