## ADDED Requirements

### Requirement: 单条重测拒绝活跃评测
单条重测 SHALL 仅接受 status 为 finished 或 error 的提交。pending 或 judging 提交的重测请求 SHALL 返回 HTTP 400，且不得删除旧结果或推送新任务。

#### Scenario: 重测评测中的提交
- **WHEN** 管理员调用 `POST /api/v1/admin/submissions/:id/rejudge`，且该提交状态为 judging
- **THEN** 系统返回 HTTP 400 并保持该提交及其现有评测任务不变
