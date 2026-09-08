# Agent Note: Admin contest 子域路由迁移

Status: implemented

## Problem

contest 域的管理员路由原先位于 `domains/contest/routes/admin-contests.ts`，直接挂在 `/api/v1/admin` 根路径下。按 Admin 后端子域迁移计划，需要将这些路由收敛到 `domains/admin/routes/contest.ts`，统一使用 `/api/v1/admin/contest/*` 路径，并为写操作接入统一审计。

## Decision

- 新建 `domains/admin/routes/contest.ts`，迁移原 `admin-contests.ts` 全部路由；在 `domains/admin/index.ts` 以 `/contest` 前缀挂载，最终路径为 `/api/v1/admin/contest/contests...`。
- `domains/contest/routes/index.ts` 只保留公开 `contestRouter`，删除 `contestAdminRouter` 导出及旧文件引用。
- 写操作审计分层：
  - `contest.ranking_snapshot` 发布在 service 层已调用 `logAudit`，保持 service 为唯一审计源，路由层不重复写。
  - 其余写操作（`contest.create`、`contest.update`、`contest.delete`、`contest.participants_add`、`contest.participants_remove`、`contest.kind_change`、`contest.reset_code`）原先未在 service 层审计，由路由层 `withAudit` 作为唯一审计源。
- 为支持上述审计，扩展 `AuditAction`/`AuditDetail` 与 `audit_logs.action` CHECK 约束，新增七个 `contest.*` 动作，并生成 Drizzle 迁移。
- 路由层审计通过 `WeakMap` 暂存请求体，供 `withAudit` 在成功响应后构造 detail。

## Alternatives considered

- 保留旧文件直接改路径：仍分散在 contest 域，无法实现 admin 统一门面。
- 不新增审计动作而复用现有动作：会丢失操作语义，且 `contest.*` 本无可用动作。
- 对 ranking-snapshot 也接路由层 `withAudit`：会与 service 层已有审计重复，因此未采用。

## Consequences

- contest 管理 API 路径变为 `/api/v1/admin/contest/contests/*`，前端与 E2E 尚未同步迁移（由后续任务覆盖）。
- `audit_logs` 新增 `contest.create/update/delete/participants_add/participants_remove/kind_change/reset_code` 动作，需要执行新迁移后才能在生产写入这些审计。
- 管理端竞赛相关测试已迁移到新路径，并补充了 create/kind/reset-code 的审计断言。
