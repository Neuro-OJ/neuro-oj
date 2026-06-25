## Purpose

定义 Neuro OJ 管理后台提交管理页面规范。该页面在 `/admin/submissions` 路径提供，允许管理员查看和管理所有用户的提交记录。

## Requirements

### Requirement: 管理员可查看所有提交记录

系统 SHALL 在 `/admin/submissions` 路径提供提交审核页面，展示所有用户的提交记录。

#### Scenario: 管理员访问提交管理

- **WHEN** 已登录管理员访问 `/admin/submissions`
- **THEN** 系统显示提交列表，包含用户名、题号、语言、状态、提交时间等字段

#### Scenario: 提交列表分页

- **WHEN** 提交记录超过每页显示数量
- **THEN** 系统显示分页控件

### Requirement: 管理员可按条件筛选提交记录

系统 SHALL 提供筛选控件，允许管理员按用户 ID、题目 ID、语言、状态、时间范围筛选提交。

#### Scenario: 按用户 ID 筛选

- **WHEN** 管理员在筛选输入框输入 user_id 并触发筛选
- **THEN** 系统仅显示该用户的提交记录

#### Scenario: 按题目 ID 筛选

- **WHEN** 管理员在筛选输入框输入 problem_id 并触发筛选
- **THEN** 系统仅显示该题目的提交记录

#### Scenario: 组合筛选

- **WHEN** 管理员同时设置多个筛选条件
- **THEN** 系统应用所有筛选条件的交集

#### Scenario: 清空筛选条件

- **WHEN** 管理员点击清空筛选按钮
- **THEN** 系统重置所有筛选条件并显示全部提交记录
