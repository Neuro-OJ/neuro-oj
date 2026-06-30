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

### Requirement: 管理员可查看任意提交详情

系统 SHALL 在 `GET /api/v1/admin/submissions/:id` 端点提供任意提交的完整详情（含源代码），该端点依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员查看提交详情

- **WHEN** 已登录管理员调用 `GET /api/v1/admin/submissions/:id`
- **THEN** 系统返回提交的所有字段，包括 `code`（源代码）、`result` 评测结果、`user_id`、`problem_id` 等

#### Scenario: 查看不存在的提交

- **WHEN** 管理员调用 `GET /api/v1/admin/submissions/:missing-id`
- **THEN** 系统返回 HTTP 404

#### Scenario: 非管理员拒绝访问

- **WHEN** 普通用户调用 `GET /api/v1/admin/submissions/:id`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可删除提交记录

系统 SHALL 在 `DELETE /api/v1/admin/submissions/:id` 端点提供删除提交记录功能，该端点依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员成功删除提交

- **WHEN** 已登录管理员调用 `DELETE /api/v1/admin/submissions/:id`
- **THEN** 系统删除该提交记录及关联的评测结果，返回 HTTP 204

#### Scenario: 删除不存在的提交

- **WHEN** 管理员调用 `DELETE /api/v1/admin/submissions/:missing-id`
- **THEN** 系统返回 HTTP 404

#### Scenario: 非管理员删除提交

- **WHEN** 普通用户调用 `DELETE /api/v1/admin/submissions/:id`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可从管理后台发起重测

系统 SHALL 在管理后台提交列表页（`/admin/submissions`）的操作列提供"重测"按钮，点击后弹出二次确认对话框。

#### Scenario: 管理员点击重测按钮

- **WHEN** 已登录管理员在提交列表中点击某行的"重测"按钮
- **THEN** 系统显示确认弹窗，询问是否确定重测

#### Scenario: 确认重测

- **WHEN** 管理员在确认弹窗中点击确认
- **THEN** 系统调用 `POST /api/v1/admin/submissions/:id/rejudge`，成功后显示 Toast "重测任务已提交"，并刷新提交列表

#### Scenario: 取消重测

- **WHEN** 管理员在确认弹窗中点击取消
- **THEN** 系统关闭弹窗，不发起任何请求

#### Scenario: 重测失败提示

- **WHEN** 重测 API 返回错误（如网络故障、服务不可用）
- **THEN** 系统显示错误提示 Toast，不刷新列表
