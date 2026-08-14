## RENAMED Requirements

- FROM: `### Requirement: 审计日志 E2E——7 类操作记录验证`
- TO: `### Requirement: 审计日志 E2E——管理操作记录验证`

## MODIFIED Requirements

### Requirement: 审计日志 E2E——管理操作记录验证

测试 SHALL 验证管理员执行操作后对应的审计日志被正确记录。

#### Scenario: 角色变更记录审计

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/role` 变更用户角色
- **THEN** 调用 `GET /api/v1/admin/audit-logs?action=users.role_change`
- **THEN** 返回列表中包含刚操作的记录
- **THEN** 记录的 `detail` 包含 `from` 和 `to` 字段

#### Scenario: 封禁/解封记录审计

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/ban`
- **THEN** 审计日志中出现 `action=users.ban` 记录
- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/unban`
- **THEN** 审计日志中出现 `action=users.unban` 记录

#### Scenario: 题解删除记录审计

- **WHEN** admin 调用 `DELETE /api/v1/problems/:id`
- **THEN** 审计日志中出现 `action=problems.delete` 记录
- **THEN** `detail` 包含 `title` 和 `display_id`

#### Scenario: 标签删除记录审计

- **WHEN** admin 调用 `DELETE /api/v1/tags/:id`
- **THEN** 审计日志中出现 `action=tags.delete` 记录
- **THEN** `detail` 包含 `name` 和 `kind`

#### Scenario: 标签合并记录审计

- **WHEN** admin 调用 `POST /api/v1/tags/:id/merge`
- **THEN** 审计日志中出现 `action=tags.merge` 记录
- **THEN** `detail` 包含 `source_name` 和 `target_name`
