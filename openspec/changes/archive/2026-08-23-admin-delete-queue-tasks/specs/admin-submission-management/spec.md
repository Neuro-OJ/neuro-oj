## MODIFIED Requirements

### Requirement: 管理员可从管理后台移除待处理评测任务

系统 SHALL 在管理后台提交列表页（`/admin/submissions`）的操作列中，为状态为 `judging` 的提交提供“移出队列”按钮，并在执行前要求二次确认。

#### Scenario: 管理员确认移出队列

- **WHEN** 管理员点击排队提交的“移出队列”按钮并在确认对话框中确认
- **THEN** 系统调用 `DELETE /api/v1/admin/queue/submissions/:id`
- **THEN** 成功后显示成功提示并刷新提交列表

#### Scenario: 移除请求进行中

- **WHEN** 管理员已对某个提交发起移除请求且请求尚未完成
- **THEN** 该提交的移除按钮不可再次触发

#### Scenario: 任务不再等待时的反馈

- **WHEN** 接口返回任务不在 pending queue 中的错误
- **THEN** 系统显示错误提示并刷新提交列表以显示最新状态
