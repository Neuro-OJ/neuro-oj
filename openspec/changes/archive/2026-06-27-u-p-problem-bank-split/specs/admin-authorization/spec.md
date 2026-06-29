## Purpose

管理员权限系统增量更新：题目操作不再独占 adminMiddleware，权限下沉至服务层；
新增 root 系统用户概念及其隐藏规则。

## ADDED Requirements

### Requirement: Root 系统用户自动创建

系统 SHALL 在启动时自动创建 `id='0'` 的 root 用户（admin 角色、随机密码、不可登录）。

#### Scenario: 首次启动创建 root
- **WHEN** noj-core 首次启动且 users 表中不存在 id='0' 的用户
- **THEN** 系统自动创建 root 用户，角色为 admin，密码为随机 UUID，bio 为"系统根用户"

#### Scenario: root 用户不可登录
- **WHEN** 尝试使用 root 用户的随机密码登录
- **THEN** 因 root 密码为随机 UUID 且机制上不对外暴露，登录失败

#### Scenario: root 用户不在用户列表中显示
- **WHEN** 管理员查询用户列表
- **THEN** 列表中不包含 id='0' 的 root 用户

## MODIFIED Requirements

### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `adminMiddleware`，用于保护非题目类的管理端点。
题目 CRUD 不再依赖 adminMiddleware，改为服务层权限判断。

#### Scenario: adminMiddleware 仍保护管理端点
- **WHEN** 普通用户访问 `/api/v1/admin/users` 等管理端点
- **THEN** adminMiddleware 返回 HTTP 403

#### Scenario: 题目端点改用服务层权限
- **WHEN** 普通用户访问 `PUT /api/v1/problems/:id`
- **THEN** 不再经过 adminMiddleware，由服务层根据 type+owner 判断
