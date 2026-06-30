## ADDED Requirements

### Requirement: 管理员可从题目列表发起批量重测

系统 SHALL 在管理后台题目列表页（`/admin/problems`）的操作列提供批量重测按钮，点击后弹出确认对话框，确认后对该题所有已完成/出错的提交执行重测。

#### Scenario: 管理员点击批量重测按钮

- **WHEN** 已登录管理员在题目列表中点击某行的"重测"按钮
- **THEN** 系统显示确认弹窗，提示将重测该题的所有提交

#### Scenario: 确认批量重测

- **WHEN** 管理员在确认弹窗中点击确认
- **THEN** 系统调用 `POST /api/v1/admin/problems/:id/rejudge`，成功后显示 Toast "批量重测任务已提交，共 N 条"，并刷新题目列表

#### Scenario: 取消批量重测

- **WHEN** 管理员在确认弹窗中点击取消
- **THEN** 系统关闭弹窗，不发起任何请求

#### Scenario: 批量重测失败提示

- **WHEN** 批量重测 API 返回错误（如网络故障、服务不可用，或该题有 pending/judging 提交）
- **THEN** 系统显示错误提示 Toast（包含服务端返回的具体错误信息）
