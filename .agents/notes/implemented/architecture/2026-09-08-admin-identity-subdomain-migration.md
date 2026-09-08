# Agent Note: Admin identity 子域路由迁移

Status: implemented

## Problem

identity 域的管理员路由原先分散在 `domains/identity/routes/admin-*.ts`，直接挂在 `/api/v1/admin` 根路径下。按 Admin 后端子域迁移计划，需要将这些路由收敛到 `domains/admin/routes/identity.ts`，统一使用 `/api/v1/admin/identity/*` 路径，并为写操作接入统一审计。

## Decision

- 新建 `domains/admin/routes/identity.ts`，合并 users、roles/permissions、blacklist 三组管理路由；在 `domains/admin/index.ts` 以 `/identity` 前缀挂载。
- `domains/identity/routes/index.ts` 只保留公开 `identityRouter`，删除 `identityAdminRouter` 导出及旧文件引用。
- 写操作统一用 `withAudit` 接入审计：`users.role_change`、`users.ban`、`users.unban`、`users.delete`、`roles.create/update/delete`、`ip_ban.create/delete`。
- 为支持角色 CRUD 审计，扩展 `AuditAction`/`AuditDetail` 与 `audit_logs.action` CHECK 约束，新增 `roles.create`/`roles.update`/`roles.delete`，并生成 Drizzle 迁移。
- 路由层审计通过 `WeakMap` 暂存请求体，供 `withAudit` 在成功响应后构造 detail；路由层审计与现有 service 层审计暂时并存。

## Alternatives considered

- 保留旧文件直接改路径：仍分散在 identity 域，无法实现 admin 统一门面。
- 角色 CRUD 不接审计：缺少关键 RBAC 变更可追溯性，不符合迁移计划要求。
- 移除 service 层已有审计以避免重复：会扩大本次改动面，并需要同步修改 service 测试；因此暂保留 service 层审计，重复项留待后续清理。

## Consequences

- identity 管理 API 路径变为 `/api/v1/admin/identity/*`，前端与 E2E 需要同步迁移（计划后续任务覆盖）。
- `audit_logs` 新增 `roles.*` 动作，需要执行新迁移后才能在生产写入这些审计。
- 部分写操作（ban/unban/delete/blacklist）在路由层和 service 层都会写审计，存在重复记录；后续可统一收敛到路由层。
