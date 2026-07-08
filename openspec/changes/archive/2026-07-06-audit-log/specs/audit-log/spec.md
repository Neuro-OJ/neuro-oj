## ADDED Requirements

### Requirement: audit_logs 表

系统 SHALL 提供 `audit_logs` 表存储管理员操作记录。

`audit_logs` SHALL 包含以下列：
- `id` (TEXT, PK) —— UUID
- `admin_id` (TEXT, NOT NULL, FK → users.id) —— 操作管理员
- `action` (TEXT, NOT NULL) —— 操作类型枚举，受 CHECK 约束
- `target_type` (TEXT, NULL) —— 目标类型（如 "user" / "problem" / "category"）
- `target_id` (TEXT, NULL) —— 目标 ID
- `detail` (JSONB, NOT NULL, DEFAULT '{}') —— 操作详情，按 action 强类型
- `ip_address` (TEXT, NOT NULL) —— 操作来源 IP
- `created_at` (TEXT, NOT NULL) —— ISO 8601 时间戳

`action` CHECK 约束 SHALL 限定为以下 7 个值之一：
- `users.role_change`
- `users.ban`
- `users.unban`
- `problems.delete`
- `categories.delete`
- `submissions.rejudge`
- `settings.update`

表 SHALL 建立以下索引：
- `audit_logs_admin_id_idx` ON `admin_id`
- `audit_logs_created_at_idx` ON `created_at`
- `audit_logs_action_idx` ON `action`

#### Scenario: 创建 audit_logs 表成功

- **WHEN** 执行 0012 migration
- **THEN** 表和 3 个索引被创建
- **THEN** 插入非法 action（如 "unknown.action"）抛 CHECK 约束错误

#### Scenario: root 用户审计记录

- **WHEN** admin_id='0' 的管理员执行任一审计操作
- **THEN** audit_logs 写入一条记录（保留可追溯性）
- **THEN** 列表 API 默认不返回该记录

### Requirement: AuditDetail 强类型

系统 SHALL 通过 TypeScript discriminated union 定义 7 类操作的 detail 字段：

```ts
type AuditDetail =
  | { action: "users.role_change"; from: string; to: string }
  | { action: "users.ban"; reason: string; until: string | null }
  | { action: "users.unban" }
  | { action: "problems.delete"; title: string; display_id: string }
  | { action: "categories.delete"; name: string; slug: string }
  | { action: "submissions.rejudge"; submission_id?: string; problem_id?: string; count?: number }
  | { action: "settings.update"; key: string; from: unknown; to: unknown };
```

`logAudit()` MUST 接受 `AuditDetail` 联合类型参数；编译期阻止传错字段。

#### Scenario: role_change detail 完整性

- **WHEN** 调用 `logAudit("users.role_change", { from: "user", to: "admin" })`
- **THEN** 编译通过，detail 写入 JSONB

#### Scenario: 缺字段编译失败

- **WHEN** 调用 `logAudit("users.ban", { reason: "spam" })`（缺 `until`）
- **THEN** TypeScript 编译报错：Property 'until' is missing

### Requirement: RequestContext 自动捕获

系统 SHALL 通过 AsyncLocalStorage 在 admin 路由作用域内传递 `RequestContext`。

`RequestContext` SHALL 包含：
- `actorId` (string) —— 当前用户 ID
- `actorIp` (string) —— 请求 IP（X-Forwarded-For 优先，回退 RemoteAddr）
- `actorRole` (string) —— 当前用户角色

`adminMiddleware` MUST 在 `c.set("userId")` / `c.set("userRole")` 之后调用 `runWithContext(ctx, () => next())`，使整条 admin 调用链可访问 context。

`getRequestContext()` MUST 在 context 未注入时抛出错误（程序 bug 保护）。

#### Scenario: admin 路由内 logAudit 成功

- **WHEN** admin 请求进入 `POST /api/v1/admin/users/:id/ban`
- **WHEN** adminMiddleware 注入 RequestContext
- **WHEN** banUser service 内 `logAudit("users.ban", {reason, until}, {type: "user", id})`
- **THEN** `getRequestContext()` 返回包含 actorId / actorIp / actorRole 的 context
- **THEN** audit_logs INSERT 成功，ip_address 等于请求客户端 IP

#### Scenario: 非 admin 路由调 logAudit 抛错

- **WHEN** service 函数（如公共 API 服务）意外调用 `logAudit`
- **THEN** `getRequestContext()` 抛 `Error("RequestContext 未注入")`
- **THEN** 触发 500 响应，暴露程序 bug

#### Scenario: 测试注入 context

- **WHEN** 测试代码 `enterTestContext({actorId: "test-admin", actorIp: "127.0.0.1", actorRole: "admin"})`
- **WHEN** service 函数内 `logAudit(...)` 被调用
- **THEN** `getRequestContext()` 返回注入的固定 context

### Requirement: 同步审计写入

系统 SHALL 在 service 层埋点，同步执行 `logAudit()` 完成 INSERT。

`logAudit()` MUST 接受三个参数：
- `action: AuditAction` —— 操作类型
- `detail: AuditDetail` —— 详情（强类型）
- `target?: { type: string; id: string }` —— 操作目标（可选）

`logAudit()` MUST 从 `RequestContext` 自动取 `admin_id` 和 `ip_address`，调用方不显式传。

`logAudit()` 失败（DB INSERT 异常）SHOULD 仅 `console.error` 记录错误，**不抛出业务错误** —— 业务操作继续进行（admin 操作不应因审计故障被拒）。

#### Scenario: banUser 写 audit_log

- **WHEN** admin 调用 `POST /api/v1/admin/users/:id/ban` with `{reason, until}`
- **WHEN** banUser service 成功执行封禁
- **THEN** audit_logs 多一条记录：action="users.ban", admin_id=当前管理员, ip_address=客户端 IP, detail={"reason", "until"}, target={type: "user", id: 目标用户}
- **THEN** HTTP 响应 200，返回更新后的用户对象

#### Scenario: audit 失败业务继续

- **WHEN** logAudit INSERT 因 audit_logs 表不存在失败（异常）
- **THEN** `console.error` 输出异常详情
- **THEN** banUser 不抛错，HTTP 响应 200，封禁生效
- **THEN** 后续告警系统（如有）通过 error 日志捕获该异常

### Requirement: 7 类操作埋点

系统 SHALL 在以下 service 函数末尾埋点（每处 1-2 条 audit）：

| Service 函数 | action | detail | target |
|--------------|--------|--------|--------|
| `promoteUser` | `users.role_change` | `{from, to}` | `{type: "user", id: 目标}` |
| `banUser` | `users.ban` | `{reason, until}` | `{type: "user", id: 目标}` |
| `unbanUser` | `users.unban` | `{}` | `{type: "user", id: 目标}` |
| `deleteProblem` | `problems.delete` | `{title, display_id}` | `{type: "problem", id: 题目}` |
| `deleteCategory` | `categories.delete` | `{name, slug}` | `{type: "category", id: 分类}` |
| `rejudgeSubmission` | `submissions.rejudge` | `{submission_id}` | `{type: "submission", id: 提交}` |
| `rejudgeProblemSubmissions` | `submissions.rejudge` | `{problem_id, count}` | `{type: "problem", id: 题目}` |

`updateSystemSetting` 埋点 (`settings.update`) 仅在 #105 合并后生效。

#### Scenario: 7 处埋点全覆盖

- **WHEN** admin 执行以下操作：role_change / ban / unban / delete problem / delete category / rejudge submission / rejudge problem
- **THEN** audit_logs 对应新增 7 条记录，字段按上表填充

### Requirement: 审计日志列表 API

系统 SHALL 提供 `GET /api/v1/admin/audit-logs` 端点。

查询参数：
- `page` (默认 1) —— 页码
- `per_page` (默认 20，上限 100) —— 每页条数
- `admin_id` (可选) —— 按管理员 ID 筛选
- `action` (可选) —— 按 action 筛选
- `from` (可选) —— ISO 8601 起始时间
- `to` (可选) —— ISO 8601 截止时间

`listAuditLogs()` MUST 默认排除 `admin_id='0'` 的记录（root 用户审计）。显式传 `admin_id=0` 可查询。

权限：仅 admin 可访问；非 admin 返回 403。

响应：`{ data: AuditLogEntry[], pagination: { page, per_page, total } }`

#### Scenario: 默认列表排除 root

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs`
- **THEN** 响应 data 不含 `admin_id='0'` 的记录
- **THEN** pagination.total 仅统计非 root 记录

#### Scenario: 按 action 筛选

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs?action=users.ban`
- **THEN** 响应仅含 action='users.ban' 的记录

#### Scenario: 按时间范围筛选

- **WHEN** admin 调用 `GET /api/v1/admin/audit-logs?from=2026-07-01T00:00:00Z&to=2026-07-04T23:59:59Z`
- **THEN** 响应仅含 created_at 在该范围内的记录

#### Scenario: 非 admin 访问 403

- **WHEN** 普通用户调用 `GET /api/v1/admin/audit-logs`
- **THEN** 返回 HTTP 403

### Requirement: 90 天保留策略

系统 SHALL 提供 `startAuditLogRetentionTask()` 后台任务。

行为：
- `main.ts` HTTP 启动后调用一次
- 启动后立即跑一次 `cleanupOldAuditLogs(days)`
- 每 24h 重复一次 `setInterval`
- `AUDIT_LOG_RETENTION_DAYS` 环境变量控制天数（默认 90，0 = 禁用）
- `cleanupOldAuditLogs(days)` 执行 `DELETE FROM audit_logs WHERE created_at <= now() - INTERVAL 'X days'`，返回删除行数
- 多实例 core 并发清理幂等（DELETE range 无副作用）
- 清理失败 `console.error` 记录，下次周期重试

#### Scenario: 默认 90 天清理

- **WHEN** `AUDIT_LOG_RETENTION_DAYS` 未设置或为 "90"
- **THEN** 启动时立即删除 `created_at <= now - 90d` 的所有记录
- **THEN** 每 24h 重复一次

#### Scenario: 禁用清理

- **WHEN** `AUDIT_LOG_RETENTION_DAYS=0`
- **THEN** 启动时输出 info 日志 "审计日志清理任务已禁用"
- **THEN** 不启动 setInterval

#### Scenario: 自定义保留期

- **WHEN** `AUDIT_LOG_RETENTION_DAYS=30`
- **THEN** 删除 `created_at <= now - 30d` 的记录

### Requirement: 管理后台 UI

系统 SHALL 提供 `/admin/audit-logs` 页面。

布局：
- 顶部筛选条：操作类型下拉（7 个 action + "全部"）、管理员下拉（来自 `/api/v1/admin/users`）、时间范围（from/to 日期选择器）、重置按钮、筛选按钮
- 中部表格列：时间（YYYY-MM-DD HH:mm:ss）、管理员（用户名）、操作（中文 label + 颜色 badge）、目标（type:id 简化展示）、详情（按 action narrow 渲染）、IP（带复制按钮）
- 底部分页（复用 `paginationNav` 组件）

详情列渲染规则：
- `users.role_change`：`{from} → {to}`
- `users.ban`：`reason + until`
- `users.unban`：`已解封`
- `problems.delete`：`title (display_id)`
- `categories.delete`：`name (slug)`
- `submissions.rejudge`：`submission_id` 或 `problem_id (×N)`
- `settings.update`：`key: from → to`

侧栏入口：navItems 新增 `{ label: "审计日志", to: "/admin/audit-logs", icon: ScrollText }`。

权限：仅 admin 可访问；非 admin 重定向至首页或显示 403。

#### Scenario: 列表渲染

- **WHEN** admin 访问 `/admin/audit-logs`
- **THEN** 加载审计日志表格（默认 page=1）
- **THEN** 每行按 action 类型渲染详情列
- **THEN** 表格按 created_at DESC 排序（最新在上）

#### Scenario: 筛选交互

- **WHEN** admin 选择 action="users.ban" + 点击"筛选"
- **THEN** 重新请求 `GET /api/v1/admin/audit-logs?action=users.ban`
- **THEN** 表格更新为仅显示 ban 操作

#### Scenario: 详情复制

- **WHEN** admin 点击 IP 列旁的复制按钮
- **THEN** IP 字符串写入剪贴板（navigator.clipboard.writeText）
- **THEN** 显示 toast "已复制"