## ADDED Requirements

### Requirement: 管理员可查看用户列表

系统 SHALL 在 `/admin/users` 路径提供用户列表页面，支持分页展示。

#### Scenario: 管理员访问用户列表

- **WHEN** 已登录管理员访问 `/admin/users`
- **THEN** 系统显示用户列表，包含用户名、邮箱、角色、注册时间等字段

#### Scenario: 用户列表分页

- **WHEN** 用户总数超过每页显示数量
- **THEN** 系统显示分页控件，管理员可切换页码

#### Scenario: 用户列表加载失败

- **WHEN** 加载用户列表时网络错误
- **THEN** 系统显示错误提示和重试按钮

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
