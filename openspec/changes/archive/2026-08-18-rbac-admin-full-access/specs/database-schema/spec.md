## ADDED Requirements

### Requirement: users.role 与 roles.is_admin 列移除

数据库 Schema SHALL 移除 `users.role` 与 `roles.is_admin` 两列，由 Drizzle 迁移执行 `ALTER TABLE` 删列；相关读写点已在代码层全部清理（见 rbac-core / admin-authorization delta）。

#### Scenario: 迁移删列成功

- **WHEN** `deno task db:migrate` 执行删列迁移
- **THEN** `users` 表与 `roles` 表不再包含 `role` / `is_admin` 列，`roles.parent_id`（角色继承）与其余 RBAC 列保持不变

#### Scenario: 删列后系统功能不受影响

- **WHEN** 删列迁移执行后运行 `init:system` / `bootstrap:admin` / 登录 / 权限检查
- **THEN** 系统正常运行，无任何代码引用已删除列
