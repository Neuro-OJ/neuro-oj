## Purpose

定义管理员提交详情查看和删除 API 规范，允许管理员查看任意提交的完整详情和删除违规提交。

## ADDED Requirements

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
