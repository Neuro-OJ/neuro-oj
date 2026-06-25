## Purpose

定义 Neuro OJ 管理后台分类管理页面规范。该页面在 `/admin/categories` 路径提供，允许管理员管理题目分类。

## Requirements

### Requirement: 管理员可查看和创建分类

系统 SHALL 在 `/admin/categories` 路径提供分类管理页面，管理员可查看所有分类并创建新分类。

#### Scenario: 管理员查看分类列表

- **WHEN** 已登录管理员访问 `/admin/categories`
- **THEN** 系统显示所有分类列表

#### Scenario: 管理员创建新分类

- **WHEN** 管理员填写分类名称并提交
- **THEN** 系统调用 `POST /api/v1/categories`，成功后分类列表更新

### Requirement: 管理员可编辑分类

系统 SHALL 允许管理员修改已有分类的名称。

#### Scenario: 管理员成功编辑分类

- **WHEN** 管理员在分类列表中选择编辑，修改名称后保存
- **THEN** 系统调用 `PUT /api/v1/categories/:id`，成功后分类列表更新

### Requirement: 管理员可删除分类

系统 SHALL 允许管理员删除分类，删除前需确认。

#### Scenario: 管理员成功删除分类

- **WHEN** 管理员点击删除按钮并在确认弹窗中确认
- **THEN** 系统调用 `DELETE /api/v1/categories/:id`，成功后从列表中移除
