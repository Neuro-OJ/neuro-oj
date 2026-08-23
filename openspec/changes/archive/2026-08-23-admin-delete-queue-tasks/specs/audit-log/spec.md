## MODIFIED Requirements

### Requirement: 评测队列移除操作审计

系统 SHALL 将 `submissions.queue_removed` 纳入 `audit_logs.action` 的 CHECK 约束和 `AuditAction` / `AuditDetail` 强类型定义，并在管理员成功移除 pending 评测任务时写入审计记录。

#### Scenario: 成功移除任务产生审计记录

- **WHEN** 管理员成功从 pending queue 移除正式提交任务
- **THEN** `audit_logs` 新增 action 为 `submissions.queue_removed` 的记录
- **THEN** 记录的 target 为 `{type: "submission", id: 提交 ID}`
