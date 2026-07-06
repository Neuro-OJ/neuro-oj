## Why

NOJ 当前所有管理员操作无日志记录。出现误操作或安全事故时无法追溯责任、复盘行为。issue #101 列出了 6 个核心写操作的审计需求，并明确要求：

- 在 **service 层**埋点（非 middleware —— 因 service 持有业务上下文，如 role_change 的 `from`/`to`、ban 的 `reason`/`until`）
- 记录 IP、admin_id、操作类型、详情、时间
- 90 天保留策略（可配置）
- 管理后台"审计日志"页面（按操作类型/管理员/时间筛选）

PR #108（IP 黑名单）已建立 `console.log("[admin] ...")` 临时约定（其 proposal "Out of Scope"段明确说"完整审计日志表（issue #101，独立工作）"）。本变更落地完整审计能力，替换临时约定。

## What Changes

### 新增能力

- **`audit-log`**：审计日志抽象 —— service 层 `logAudit()` 同步写入 + ALS 上下文自动捕获 + 7 类强类型 `AuditDetail` discriminated union + 后台保留清理任务 + admin UI 查看页

### 修改能力

- **`admin-routes`**：新增 `GET /api/v1/admin/audit-logs`（分页 + 筛选）；现有 7 个 admin 端点路由层零改动（service 内部已埋点）
- **`admin-frontend`**：侧栏新增"审计日志"入口 + 新建 `pages/admin/audit-logs.vue`（按 action 类型渲染 detail 列）
- **`user-auth`**：`adminMiddleware` 注入 `RequestContext`（actorId / actorIp / actorRole）至 AsyncLocalStorage
- **`admin-services`**：`promoteUser` / `banUser` / `unbanUser` / `deleteProblem` / `deleteCategory` / `rejudgeSubmission` / `rejudgeProblemSubmissions` 各埋点 1-2 条审计（V1 共 7 处；`settings.update` 在 #105 接入时埋点）

## Impact

- **数据库**：新增 `audit_logs` 表（7 列 + 1 个 CHECK 约束 + 3 个索引）
- **noj-core**：
  - 新增 `src/lib/requestContext.ts`（ALS 封装）
  - 新增 `src/services/audit-log.ts`（logAudit / listAuditLogs / cleanupOldAuditLogs / startAuditLogRetentionTask）
  - 新增 `src/types/audit-log.ts`（AuditAction / AuditDetail / AuditLogEntry）
  - 改造 `src/middleware/auth.ts`（adminMiddleware 注入 ALS 上下文）
  - 改造 `src/db/schema.ts` + `src/db/schema-ddl.ts`（新增 auditLogs 表）
  - 改造 5 个 service 文件（埋点）：`auth.ts`、`users.ts`、`problems.ts`、`categories.ts`、`submissions.ts`
  - 新增 `src/routes/admin.ts` 端点：`GET /audit-logs`
  - 改造 `src/main.ts`：HTTP 启动后调用 `startAuditLogRetentionTask()`
  - 新增迁移 `drizzle/0012_audit_logs.sql`
- **noj-ui**：
  - 新增 `pages/admin/audit-logs.vue`
  - 改造 `layouts/admin.vue`（侧栏 navItems 加"审计日志"）
- **环境变量**：新增 `AUDIT_LOG_RETENTION_DAYS`（默认 90；0 = 禁用清理）
- **性能**：每个 admin 写操作多 1 次 DB INSERT（约 1-3ms）；后台清理每天 1 次 range DELETE（90 天索引扫描）
- **一致性**：logAudit 失败 → 仅记录 error 日志，业务操作继续（admin 操作不应因审计失败被拒）
- **向后兼容**：root 用户 (UID=0) 的审计仍记录，但列表 UI 默认隐藏

## Out of Scope

- 元审计（"admin X 查看了审计日志"）—— 噪音大，独立 issue 处理
- 审计日志导出（CSV/JSON）—— 后续
- 审计日志修改/删除端点 —— 审计只增不改不删
- 实时推送（SSE 新审计到来通知）—— 后续
- 按 IP 反查 / 聚合统计 —— 后续
- IPv6 IP 处理（复用既有 `getClientIp` 工具，支持 X-Forwarded-For 标准行为）

## 关联

- Closes #101
- 衔接 #108（PR #108 的 `console.log("[admin] ...")` 临时约定落地为真实审计；本变更不删除 #108 的 console.log，由后续 #108 cleanup commit 处理）
- 衔接 #105（系统设置面板接入时，在 `updateSystemSetting` 内埋点 `settings.update`；如 #105 先合并则本变更的埋点清单同步包含 settings.update）