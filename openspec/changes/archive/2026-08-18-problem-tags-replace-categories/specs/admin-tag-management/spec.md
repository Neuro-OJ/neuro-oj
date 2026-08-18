## ADDED Requirements

### Requirement: 管理员可查看和管理标签

系统 SHALL 在 `/admin/tags` 路径提供标签管理页面，仅 admin 可访问（页面走既有 admin 守卫）。页面以表格展示全部标签（名称、kind、关联题目数），支持创建（填写 name + 选择 kind）、重命名、修改 kind、合并（选择目标标签）与删除（danger 确认弹窗）。页面调用的写接口受 `tag:manage` RBAC 权限保护（默认仅 admin，运营者可另行配置角色）。

#### Scenario: 管理员查看标签列表

- **WHEN** 已登录管理员访问 `/admin/tags`
- **THEN** 系统调用 `GET /api/v1/tags` 并显示全部标签（名称、kind、关联题目数）

#### Scenario: 管理员创建标签

- **WHEN** 管理员填写标签名称并选择 kind 后提交
- **THEN** 系统调用 `POST /api/v1/tags`，成功后标签列表更新

#### Scenario: 管理员重命名/改 kind

- **WHEN** 管理员编辑标签名称或 kind 并保存
- **THEN** 系统调用 `PUT /api/v1/tags/:id`，成功后标签列表更新

#### Scenario: 管理员合并标签

- **WHEN** 管理员对某标签发起合并并选择目标标签
- **THEN** 系统调用 `POST /api/v1/tags/:id/merge`，成功后源标签从列表移除

#### Scenario: 管理员删除标签

- **WHEN** 管理员点击删除按钮并在确认弹窗中确认
- **THEN** 系统调用 `DELETE /api/v1/tags/:id`，成功后标签从列表中移除

#### Scenario: 非管理员访问被拒

- **WHEN** 普通用户访问 `/admin/tags`
- **THEN** 系统重定向至首页（admin 守卫）
