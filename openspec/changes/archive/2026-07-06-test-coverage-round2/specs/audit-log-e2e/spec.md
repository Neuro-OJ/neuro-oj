## ADDED Requirements

### Requirement: 审计日志 E2E——7 类操作记录验证

测试 SHALL 验证管理员执行操作后对应的审计日志被正确记录。

#### Scenario: 角色变更记录审计

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/role` 变更用户角色
- **THEN** 调用 `GET /api/v1/admin/audit-logs?action=users.role_change`
- **THEN** 返回列表中包含刚操作的记录
- **THEN** 记录的 `detail` 包含 `from` 和 `to` 字段

#### Scenario: 封禁/解封记录审计

- **WHEN** admin 调用 `POST /api/v1/admin/users/:id/ban`
- **THEN** 审计日志中出现 `action=users.ban` 记录
- **WHEN** admin 调用 `POST /api/v1/admin/users/:id/unban`
- **THEN** 审计日志中出现 `action=users.unban` 记录

#### Scenario: 题解删除记录审计

- **WHEN** admin 调用 `DELETE /api/v1/admin/problems/:id`
- **THEN** 审计日志中出现 `action=problems.delete` 记录
- **THEN** `detail` 包含 `title` 和 `display_id`

#### Scenario: 分类删除记录审计

- **WHEN** admin 调用 `DELETE /api/v1/admin/categories/:id`
- **THEN** 审计日志中出现 `action=categories.delete` 记录
- **THEN** `detail` 包含 `name` 和 `slug`

### Requirement: 审计日志列表查询 E2E

测试 SHALL 验证审计日志列表 API 的筛选和分页。

#### Scenario: 按时间范围筛选

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs?from=<today_start>&to=<today_end>`
- **THEN** 返回列表仅含该时间范围内的记录
- **THEN** `pagination.total` 反映筛选后的数量

#### Scenario: 分页正确

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs?per_page=5&page=1`
- **THEN** 返回不超过 5 条记录
- **THEN** `pagination.per_page` 等于 5

#### Scenario: 默认排除 root 用户

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs`
- **THEN** 返回列表中不含 `admin_id='0'` 的记录

#### Scenario: 非管理员 403

- **WHEN** 普通用户调用 `GET /api/v1/admin/audit-logs`
- **THEN** 返回 HTTP 403
