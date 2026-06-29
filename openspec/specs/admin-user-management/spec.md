## Purpose

定义 Neuro OJ 管理后台用户管理页面规范。该页面在 `/admin/users` 路径提供，允许管理员查看和管理平台用户。

## Requirements

### Requirement: 管理员可查看用户列表（增强）

系统 SHALL 在 `/admin/users` 路径提供用户列表页面，支持分页展示。后端 `GET /api/v1/admin/users` 端点增强支持按关键字搜索和按角色、日期范围筛选。

#### Scenario: 管理员访问用户列表

- **WHEN** 已登录管理员访问 `/admin/users`
- **THEN** 系统显示用户列表，包含用户名、邮箱、角色、注册时间等字段

#### Scenario: 用户列表分页

- **WHEN** 用户总数超过每页显示数量
- **THEN** 系统显示分页控件，管理员可切换页码

#### Scenario: 用户列表加载失败

- **WHEN** 加载用户列表时网络错误
- **THEN** 系统显示错误提示和重试按钮

#### Scenario: 按关键字搜索用户

- **WHEN** 管理员传入 `keyword` 查询参数调用 `GET /api/v1/admin/users?keyword=john`
- **THEN** 系统返回用户名或邮箱中包含 "john" 的用户列表

#### Scenario: 按角色筛选用户

- **WHEN** 管理员传入 `role` 查询参数调用 `GET /api/v1/admin/users?role=admin`
- **THEN** 系统仅返回角色为 `admin` 的用户列表

#### Scenario: 按注册日期范围筛选

- **WHEN** 管理员传入 `from` 和 `to` 参数调用 `GET /api/v1/admin/users?from=2026-01-01&to=2026-06-01`
- **THEN** 系统仅返回在指定日期范围内注册的用户

#### Scenario: 组合筛选

- **WHEN** 管理员同时传入 `keyword`、`role`、`from`、`to` 中多个参数
- **THEN** 系统应用所有参数的交集进行筛选

### Requirement: 管理员可切换用户角色

系统 SHALL 允许管理员将任意用户的角色在 `admin` 和 `user` 之间切换。

#### Scenario: 管理员将用户提升为管理员

- **WHEN** 管理员点击用户的"设为管理员"按钮并确认
- **THEN** 系统调用 `PATCH /api/v1/admin/users/:id/role`，成功后该用户角色更新为 admin，页面刷新

#### Scenario: 管理员将管理员降级为普通用户

- **WHEN** 管理员点击某 admin 用户的"设为用户"按钮并确认
- **THEN** 系统调用 `PATCH /api/v1/admin/users/:id/role`，成功后该用户角色更新为 user，页面刷新

#### Scenario: 角色切换失败

- **WHEN** 角色切换 API 调用失败（如试图修改自己的角色）
- **THEN** 系统显示错误提示，角色状态保持不变

### Requirement: 管理员可编辑用户资料

系统 SHALL 提供 `PUT /api/v1/admin/users/:id` 端点，允许管理员编辑任意用户的 `email` 和 `bio` 字段（均为可选，至少提供一个）。

此端点 MUST 依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员成功更新用户邮箱

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:id`，JSON body 包含 `{"email": "new@example.com"}`
- **THEN** 系统更新该用户的 email 字段，返回 200 与更新后的用户信息

#### Scenario: 管理员成功更新用户 bio

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:id`，JSON body 包含 `{"bio": "新简介"}`
- **THEN** 系统更新该用户的 bio 字段，返回 200

#### Scenario: 管理员同时更新 email 和 bio

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:id`，JSON body 同时包含 `email` 和 `bio`
- **THEN** 系统同时更新两个字段，返回 200

#### Scenario: 更新为已存在的邮箱

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:id`，email 已被其他用户使用
- **THEN** 系统返回 HTTP 409，提示 "邮箱已被注册"

#### Scenario: 编辑不存在的用户

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:missing-id`
- **THEN** 系统返回 HTTP 404

#### Scenario: 未提供任何可更新字段

- **WHEN** 管理员调用 `PUT /api/v1/admin/users/:id`，JSON body 为空或不包含 email 和 bio
- **THEN** 系统返回 HTTP 400，提示 "至少需要提供一个可更新字段"

#### Scenario: 非管理员拒绝访问

- **WHEN** 普通用户调用 `PUT /api/v1/admin/users/:id`
- **THEN** 系统返回 HTTP 403
