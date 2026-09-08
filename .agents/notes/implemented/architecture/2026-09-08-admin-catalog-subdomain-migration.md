# Agent Note: Admin catalog 子域路由迁移

Status: implemented

## Problem

catalog 域的管理员路由原先分散在 `domains/catalog/routes/admin-problems.ts` 与 `admin-trainings.ts`，直接挂在 `/api/v1/admin` 根路径下。按 Admin 后端子域迁移计划，需要将这些路由收敛到 `domains/admin/routes/catalog.ts`，统一使用 `/api/v1/admin/catalog/*` 路径，并为写操作接入统一审计。

## Decision

- 新建 `domains/admin/routes/catalog.ts`，合并 problems 与 trainings 两组管理路由；在 `domains/admin/index.ts` 以 `/catalog` 前缀挂载。
- `domains/catalog/routes/index.ts` 只保留公开 `catalogRouter`，删除 `catalogAdminRouter` 导出及旧文件引用。
- `problems/review` 与 `trainings` 的细粒度权限在具体 handler 内保留（`problem:create_p`、`training:read_any/write_any/publish/pin/delete_any`）；通用题目管理仍要求 `admin:full_access`。
- 写操作审计分层：`problems.review`、`trainings.update`、`trainings.delete` 原先未在 service 层审计，因此由路由层 `withAudit` 作为唯一审计源。
- 为支持上述审计，扩展 `AuditAction`/`AuditDetail` 与 `audit_logs.action` CHECK 约束，新增 `problems.review`、`trainings.update`、`trainings.delete`，并生成 Drizzle 迁移。
- 路由层审计通过 `WeakMap` 暂存请求体，供 `withAudit` 在成功响应后构造 detail。

## Alternatives considered

- 保留旧文件直接改路径：仍分散在 catalog 域，无法实现 admin 统一门面。
- 不新增审计动作而复用现有动作：会丢失操作语义，且 `trainings.*` 本无可用动作。
- 依赖 `FINE_GRAINED_ADMIN_PREFIXES` 放行新路径：安全权限仍以子路由内声明为准，但该常量计划后续删除，故 catalog 子域改为自包含认证/上下文/权限，避免新增对该常量的依赖。

## Consequences

- catalog 管理 API 路径变为 `/api/v1/admin/catalog/*`，前端与 E2E 尚未同步迁移（由后续任务覆盖）。
- `audit_logs` 新增 `problems.review`、`trainings.update`、`trainings.delete` 动作，需要执行新迁移后才能在生产写入这些审计。
- 训练管理路由测试需在清理用户前删除审计日志，避免外键冲突。
