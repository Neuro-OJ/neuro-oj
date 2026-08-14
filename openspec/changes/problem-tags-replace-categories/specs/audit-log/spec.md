## RENAMED Requirements

- FROM: `### Requirement: 7 类操作埋点`
- TO: `### Requirement: 管理操作埋点`

## MODIFIED Requirements

### Requirement: audit_logs 表

系统 SHALL 提供 `audit_logs` 表存储管理员操作记录。

`audit_logs` SHALL 包含以下列：
- `id` (TEXT, PK) —— UUID
- `admin_id` (TEXT, NOT NULL, FK → users.id) —— 操作管理员
- `action` (TEXT, NOT NULL) —— 操作类型枚举，受 CHECK 约束
- `target_type` (TEXT, NULL) —— 目标类型（如 "user" / "problem" / "tag"）
- `target_id` (TEXT, NULL) —— 目标 ID
- `detail` (JSONB, NOT NULL, DEFAULT '{}') —— 操作详情，按 action 强类型
- `ip_address` (TEXT, NOT NULL) —— 操作来源 IP
- `created_at` (TEXT, NOT NULL) —— ISO 8601 时间戳

`action` CHECK 约束 SHALL 限定为以下 10 个值之一：
- `users.role_change`
- `users.ban`
- `users.unban`
- `problems.delete`
- `tags.create`
- `tags.update`
- `tags.delete`
- `tags.merge`
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

#### Scenario: 标签审计 action 入列

- **WHEN** 执行标签系统迁移
- **THEN** `action` CHECK 约束更新为 10 个值（含 `tags.create`/`tags.update`/`tags.delete`/`tags.merge`），`categories.delete` 不再合法

#### Scenario: root 用户审计记录

- **WHEN** admin_id='0' 的管理员执行任一审计操作
- **THEN** audit_logs 写入一条记录（保留可追溯性）
- **THEN** 列表 API 默认不返回该记录

### Requirement: AuditDetail 强类型

系统 SHALL 通过 TypeScript discriminated union 定义 10 类操作的 detail 字段：

```ts
type AuditDetail =
  | { action: "users.role_change"; from: string; to: string }
  | { action: "users.ban"; reason: string; until: string | null }
  | { action: "users.unban" }
  | { action: "problems.delete"; title: string; display_id: string }
  | { action: "tags.create"; name: string; kind: string }
  | { action: "tags.update"; from: string; to: string }
  | { action: "tags.delete"; name: string; kind: string }
  | { action: "tags.merge"; source_name: string; target_name: string }  | { action: "submissions.rejudge"; submission_id?: string; problem_id?: string; count?: number }
  | { action: "settings.update"; key: string; from: unknown; to: unknown };
```

`logAudit()` MUST 接受 `AuditDetail` 联合类型参数；编译期阻止传错字段。

#### Scenario: role_change detail 完整性

- **WHEN** 调用 `logAudit("users.role_change", { from: "user", to: "admin" })`
- **THEN** 编译通过，detail 写入 JSONB

#### Scenario: 缺字段编译失败

- **WHEN** 调用 `logAudit("users.ban", { reason: "spam" })`（缺 `until`）
- **THEN** TypeScript 编译报错：Property 'until' is missing

### Requirement: 管理操作埋点

系统 SHALL 在以下 service 函数末尾埋点（每处 1-2 条 audit）：

| Service 函数 | action | detail | target |
|--------------|--------|--------|--------|
| `promoteUser` | `users.role_change` | `{from, to}` | `{type: "user", id: 目标}` |
| `banUser` | `users.ban` | `{reason, until}` | `{type: "user", id: 目标}` |
| `unbanUser` | `users.unban` | `{}` | `{type: "user", id: 目标}` |
| `deleteProblem` | `problems.delete` | `{title, display_id}` | `{type: "problem", id: 题目}` |
| `createTag` | `tags.create` | `{name, kind}` | `{type: "tag", id: 标签}` |
| `updateTag` | `tags.update` | `{from, to}`（from/to 为 `"name (kind)"` 格式串，表示旧值/新值） | `{type: "tag", id: 标签}` |
| `deleteTag` | `tags.delete` | `{name, kind}` | `{type: "tag", id: 标签}` |
| `mergeTags` | `tags.merge` | `{source_name, target_name}` | `{type: "tag", id: 源标签}` |
| `rejudgeSubmission` | `submissions.rejudge` | `{submission_id}` | `{type: "submission", id: 提交}` |
| `rejudgeProblemSubmissions` | `submissions.rejudge` | `{problem_id, count}` | `{type: "problem", id: 题目}` |

`updateSystemSetting` 埋点 (`settings.update`) 仅在 `admin-system-settings` 合并后生效。

#### Scenario: 埋点全覆盖

- **WHEN** admin 执行以下操作：role_change / ban / unban / delete problem / create tag / update tag / delete tag / merge tags / rejudge submission / rejudge problem
- **THEN** audit_logs 对应新增 10 条记录，字段按上表填充

### Requirement: 管理后台 UI

系统 SHALL 提供 `/admin/audit-logs` 页面。

布局：
- 顶部筛选条：操作类型下拉（10 个 action + "全部"）、管理员下拉（来自 `/api/v1/admin/users`）、时间范围（from/to 日期选择器）、重置按钮、筛选按钮
- 中部表格列：时间（YYYY-MM-DD HH:mm:ss）、管理员（用户名）、操作（中文 label + 颜色 badge）、目标（type:id 简化展示）、详情（按 action narrow 渲染）、IP（带复制按钮）
- 底部分页（复用 `paginationNav` 组件）

详情列渲染规则：
- `users.role_change`：`{from} → {to}`
- `users.ban`：`reason + until`
- `users.unban`：`已解封`
- `problems.delete`：`title (display_id)`
- `tags.create`：`name (kind)`
- `tags.update`：`from → to`
- `tags.delete`：`name (kind)`
- `tags.merge`：`source_name → target_name`
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

- **WHEN** admin 选择操作类型 "tags.delete" 并点击筛选
- **THEN** 系统调用 `GET /api/v1/admin/audit-logs?action=tags.delete`，表格展示对应记录

