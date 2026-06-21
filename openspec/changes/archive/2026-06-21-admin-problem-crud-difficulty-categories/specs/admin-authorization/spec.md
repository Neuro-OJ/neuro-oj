## ADDED Requirements

### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `adminMiddleware`，当请求用户角色不是 `admin` 时返回 403
禁止访问。

#### Scenario: 普通用户访问管理端点

- **WHEN** 已登录但角色为 `user` 的用户携带有效 JWT 调用管理员端点
- **THEN** 系统返回 HTTP 403，错误信息为 "需要管理员权限"

#### Scenario: 未登录用户访问管理端点

- **WHEN** 未携带 JWT 的用户调用管理员端点
- **THEN** 系统在 `adminMiddleware` 之前由 `authMiddleware` 返回 HTTP 401

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
