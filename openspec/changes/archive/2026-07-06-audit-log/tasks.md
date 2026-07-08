# 任务清单 — Issue #101 审计日志

## 1. OpenSpec 提案（已完成规划）

- [x] 1.1 写 `proposal.md`（Why / What / Impact / Out of Scope）
- [x] 1.2 写 `design.md`（Context / Goals / 9 项 Decisions / Schema / Risks）
- [x] 1.3 写 `specs/audit-log/spec.md`（8 个 ADDED Requirements + 20 个 Scenarios）
- [x] 1.4 写本 tasks.md

## 2. DB 迁移

- [ ] 2.1 写 `noj-core/drizzle/0012_audit_logs.sql`（建表 + CHECK + 3 索引）
- [ ] 2.2 更新 `noj-core/drizzle/meta/_journal.json`（追加 0012 条目）
- [ ] 2.3 同步 `noj-core/src/db/schema.ts`（新增 auditLogs 表）
- [ ] 2.4 同步 `noj-core/src/db/schema-ddl.ts`（SCHEMA_DDL + SCHEMA_INDEXES 数组）

## 3. 基础类型 + ALS

- [ ] 3.1 `noj-core/src/types/audit-log.ts`：AuditAction / AuditDetail / AuditLogEntry
- [ ] 3.2 `noj-core/src/lib/requestContext.ts`：AsyncLocalStorage 封装（runWithContext / getRequestContext / enterTestContext）

## 4. Middleware 注入

- [ ] 4.1 `noj-core/src/middleware/auth.ts` 改造：adminMiddleware 在 c.set("userRole") 后调 `runWithContext`
- [ ] 4.2 复用既有 `getClientIp(c.req)` 工具（X-Forwarded-For + RemoteAddr 兜底）

## 5. Service —— logAudit 核心

- [ ] 5.1 `noj-core/src/services/audit-log.ts`：
  - `logAudit(action, detail, target?)` —— 同步 INSERT，失败 console.error 不抛业务错误
  - `listAuditLogs(filter)` —— 分页 + admin_id/action/from/to 筛选，默认排除 root
  - `cleanupOldAuditLogs(days)` —— DELETE range，返回删除行数
  - `startAuditLogRetentionTask()` —— 启动立即跑一次 + setInterval 24h 周期；AUDIT_LOG_RETENTION_DAYS=0 禁用

## 6. 埋点（service 层 7 处）

- [ ] 6.1 `noj-core/src/services/auth.ts`：promoteUser 末尾 `logAudit("users.role_change", {from, to}, {type: "user", id})`
- [ ] 6.2 `noj-core/src/services/users.ts`：banUser 末尾 `logAudit("users.ban", {reason, until}, {type: "user", id})`
- [ ] 6.3 `noj-core/src/services/users.ts`：unbanUser 末尾 `logAudit("users.unban", {}, {type: "user", id})`
- [ ] 6.4 `noj-core/src/services/problems.ts`：deleteProblem 末尾 `logAudit("problems.delete", {title, display_id}, {type: "problem", id})`
- [ ] 6.5 `noj-core/src/services/categories.ts`：deleteCategory 末尾 `logAudit("categories.delete", {name, slug}, {type: "category", id})`
- [ ] 6.6 `noj-core/src/services/submissions.ts`：rejudgeSubmission 末尾 `logAudit("submissions.rejudge", {submission_id}, ...)`
- [ ] 6.7 `noj-core/src/services/submissions.ts`：rejudgeProblemSubmissions 末尾 `logAudit("submissions.rejudge", {problem_id, count}, ...)`
- [ ] 6.8 [条件性] `noj-core/src/services/settings.ts`：updateSystemSetting 末尾 `logAudit("settings.update", {key, from, to}, {type: "setting", id: key})` —— 仅当 #105 已合并

## 7. 路由

- [ ] 7.1 `noj-core/src/routes/admin.ts`：`GET /audit-logs`（分页 + 筛选）

## 8. main.ts

- [ ] 8.1 `noj-core/src/main.ts`：HTTP 启动后 `startAuditLogRetentionTask()`

## 9. 后端测试

- [ ] 9.1 `noj-core/tests/services/audit-log.test.ts`：logAudit 写入 / 字段映射 / ALS 缺失抛错 / cleanupOldAuditLogs / listAuditLogs 5 维度筛选
- [ ] 9.2 `noj-core/tests/routes/admin-audit-logs.test.ts`：200 + 分页 + 401 + 403 + admin_id / action / from / to 筛选
- [ ] 9.3 `noj-core/tests/services/auth.test.ts`：promoteUser 后 audit_logs 多 1 条 role_change 记录
- [ ] 9.4 `noj-core/tests/services/users.test.ts`：banUser / unbanUser 各多 1 条
- [ ] 9.5 `noj-core/tests/services/problems.test.ts`：deleteProblem 多 1 条
- [ ] 9.6 `noj-core/tests/services/categories.test.ts`：deleteCategory 多 1 条
- [ ] 9.7 `noj-core/tests/services/submissions.test.ts`：rejudgeSubmission / rejudgeProblemSubmissions 各多 1 条

## 10. 前端

- [ ] 10.1 `noj-ui/composables/useAuditLogs.ts`：列表数据 + 筛选状态管理
- [ ] 10.2 `noj-ui/pages/admin/audit-logs.vue`：筛选条 + 表格 + 分页；detail 列按 action narrow 渲染（7 个渲染分支）
- [ ] 10.3 `noj-ui/layouts/admin.vue`：navItems 新增 `{ label: "审计日志", to: "/admin/audit-logs", icon: ScrollText }`

## 11. 环境变量文档

- [ ] 11.1 `noj-core/.env.example`：新增 `AUDIT_LOG_RETENTION_DAYS=90`
- [ ] 11.2 `noj-core/AGENTS.md`：环境变量表加 `AUDIT_LOG_RETENTION_DAYS`
- [ ] 11.3 `AGENTS.md`（根）：已知限制章节追加"审计日志保留 90 天"

## 12. 验证

- [ ] 12.1 `deno fmt --check` 通过
- [ ] 12.2 `deno lint` 通过
- [ ] 12.3 `deno task test` 全量通过（既有 343+ + 新增 10+ = 353+）
- [ ] 12.4 `noj-ui npm run build` 成功
- [ ] 12.5 端到端冒烟：curl ban 用户 → curl GET /admin/audit-logs → 见到对应记录 + IP + detail

## 13. 提交 + PR

- [ ] 13.1 GPG 签名 commit（Conventional Commits + 中文描述）
- [ ] 13.2 squash 历史（如有 `chore:` 占位）
- [ ] 13.3 `jj git push` 或 `git push --set-upstream` 到 `origin/feat/issue-101-audit-log`
- [ ] 13.4 `gh pr create` 标题 `feat(core,ui): 审计日志：管理员操作记录（issue #101）`，body 含验收项 + OpenSpec 引用
- [ ] 13.5 添加 reviewer（@box3-galen-nv）