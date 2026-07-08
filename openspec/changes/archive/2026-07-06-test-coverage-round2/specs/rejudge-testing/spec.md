## ADDED Requirements

### Requirement: 单条提交重测 E2E

测试 SHALL 验证管理员对单条提交发起重测的完整流程。

#### Scenario: 管理员重测已完成提交

- **WHEN** 通过 pipeline 提交正确代码获得 `finished` + `Accepted` 的提交
- **WHEN** admin 调用 `POST /api/v1/admin/submissions/:id/rejudge`
- **THEN** 返回 HTTP 200
- **THEN** 响应包含 `message` 和 `submission_id`
- **THEN** 提交状态重置为 `pending`
- **THEN** 轮询等待重测完成，最终状态变回 `finished`
- **THEN** 重测结果与原始结果一致（Accepted）

#### Scenario: 重测不存在的提交

- **WHEN** admin 调用 `POST /api/v1/admin/submissions/nonexistent-id/rejudge`
- **THEN** 返回 HTTP 404

#### Scenario: 非管理员重测被拒

- **WHEN** 普通用户调用 `POST /api/v1/admin/submissions/:id/rejudge`
- **THEN** 返回 HTTP 403

### Requirement: 批量重测 E2E

测试 SHALL 验证管理员对某题所有已完成的提交批量重测。

#### Scenario: 批量重测成功

- **WHEN** 某题下有若干 `finished` 状态的提交
- **WHEN** admin 调用 `POST /api/v1/admin/problems/:id/rejudge`
- **THEN** 返回 HTTP 200
- **THEN** 响应包含 `total`、`queued`、`skipped`
- **THEN** `total` 和 `queued` 均大于 0

#### Scenario: 批量重测因活跃提交被拒绝

- **WHEN** 某题下有 `pending` 或 `judging` 状态的提交
- **WHEN** admin 调用 `POST /api/v1/admin/problems/:id/rejudge`
- **THEN** 返回 HTTP 400

### Requirement: 重测使用最新配置

测试 SHALL 验证重测使用题目当前的评测配置。

#### Scenario: 更新配置后重测

- **WHEN** 某提交最初使用旧配置运行
- **WHEN** 管理员更新题目的 `time_limit_ms`
- **WHEN** 对该提交发起重测
- **THEN** MQ 消息中的 `time_limit_ms` 为新配置值

### Requirement: 重测审计日志

测试 SHALL 验证重测操作被审计日志记录。

#### Scenario: 重测记录审核日志

- **WHEN** admin 发起单条重测
- **THEN** `GET /api/v1/admin/audit-logs?action=submissions.rejudge` 中包含该操作记录
- **THEN** `detail` 包含 `submission_id`
