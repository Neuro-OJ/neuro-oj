## ADDED Requirements

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
