## Context

NOJ 管理员操作零审计。issue #101 列出 6 类核心写操作需追溯：

| 操作 | 调用点 |
|------|--------|
| 用户角色变更 | `promoteUser` (services/auth.ts) |
| 用户封禁/解封 | `banUser` / `unbanUser` (services/users.ts) |
| 题目删除 | `deleteProblem` (services/problems.ts) |
| 分类删除 | `deleteCategory` (services/categories.ts) |
| 提交重测 | `rejudgeSubmission` / `rejudgeProblemSubmissions` (services/submissions.ts) |
| 系统设置修改 | `updateSystemSetting` (services/settings.ts，#105 接入) |

约束：

- 审计写入必须在 service 层（issue 明确："非 middleware —— 需要业务上下文"）
- service 函数不持有 Hono context，IP 需要跨越调用栈传递
- 6-8 处埋点不宜污染函数签名
- 90 天保留 + 可配置

## Goals / Non-Goals

**Goals:**
- 同步直写 audit_logs 表（强一致；admin 操作非高频路径，1-3ms 可接受）
- ALS 传递 actorId / actorIp / actorRole，service 函数零签名改动
- 7 类操作各自强类型 detail（discriminated union），编译期杜绝字段错误
- 后台 setInterval 任务每日清理过期日志（24h 周期 + 启动立即跑一次）
- 管理后台查看页（分页 + 多维度筛选 + 按 action narrow 渲染 detail 列）
- root 用户审计记录保留但 UI 默认隐藏

**Non-Goals:**
- 异步写入（Redis stream / 消息队列）—— 复杂度 > 收益
- 元审计（查看审计日志本身）—— 噪音大
- 审计日志导出 / 实时推送 / 聚合统计 —— 后续 issue
- 审计日志修改 / 删除端点 —— DB 层只增不改

## Decisions

### 1. 写入方式：同步直写 DB

每个 admin 写操作 service 末尾 `await logAudit(action, detail)`，失败仅 `console.error`，业务操作继续。

**替代方案**：Redis Stream + worker 消费 → 引入新的故障面（worker 挂了会丢日志）；admin 操作非高频路径无必要性。

### 2. IP 传递：AsyncLocalStorage

`adminMiddleware` 注入 `RequestContext` 到 ALS，service 内 `getRequestContext()` 取用。

**替代方案**：6-8 个 service 函数加 `actorIp?: string` 参数 → 污染签名；日后扩展（如 user-agent）需再改一遍。

`AsyncLocalStorage` 来自 `node:async_hooks`（Deno 兼容），性能开销可忽略。

### 3. detail 强类型：TypeScript discriminated union

按 action 类型 narrow，编译期检查字段完整性：

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

**替代方案**：`Record<string, unknown>` → 无类型保护；UI 渲染到处 `as any`。

新增 action 时必须扩展 union —— 这正是我们想要的"显式优于隐式"。

### 4. 保留策略：setInterval 后台任务

`main.ts` 启动 HTTP 后调用 `startAuditLogRetentionTask()`：
- 读 `AUDIT_LOG_RETENTION_DAYS`（默认 90，0 = 禁用）
- 启动立即跑一次 `cleanupOldAuditLogs(days)`
- 每 24h 重复一次
- 多实例幂等（DELETE range 无副作用）

**替代方案**：
- 写时惰性清理 → 不可预测；冷启动后过期日志残留
- PG 表分区按月 + DROP PARTITION → 改造 schema，前期过度工程
- pg_cron 扩展 → 依赖外部依赖
- 手动清理端点 → 部署侧需要额外配置

### 5. 字段冗余：保留 `target_type` + `target_id`

虽然 detail JSONB 中已有 target 信息，仍保留独立列。理由：

- 列表查询不必 parse JSONB
- 按 (target_type, target_id) 复合过滤更快（即便目前没用到，后续按题目 ID 反查审计是常见诉求）
- 写入成本可忽略（2 列 vs 1 JSONB 字段）

### 6. IP 缺失处理：抛错而非 NULL

`getRequestContext()` 缺失时抛 `Error("RequestContext 未注入")`。理由：

- 审计完整性 > 优雅降级
- 该错误暴露的是程序 bug（logAudit 在非 admin 路由被调用），不应静默
- 测试用 `enterTestContext()` 注入固定 context

### 7. logAudit 失败：仅 error 日志，业务继续

audit_logs INSERT 失败 → `console.error` + 吞异常，业务操作不回滚。理由：

- admin 操作不应因审计失败被拒（用户体验差；且审计故障应是独立告警）
- 强一致（业务回滚）只在审计缺失会导致数据不一致时才有意义，此处不存在
- 实际操作中 DB INSERT 失败的概率极低（同一连接、同一事务）

### 8. root 用户审计处理

`admin_id='0'` 的审计**仍记录**（不丢可追溯性），但：

- `listAuditLogs` 列表查询默认 WHERE `admin_id != '0'`
- 显式传 `?admin_id=0` 可查询（应急排障）

### 9. UI 列表分页 / 筛选

- page / per_page（默认 20，上限 100）
- 可选筛选：admin_id / action / from / to
- 复用项目既有 `paginationNav` 组件
- detail 列按 action narrow 渲染（每个 action 一个渲染函数）

## Schema 草案

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT audit_logs_action_check CHECK (
    action IN (
      'users.role_change',
      'users.ban',
      'users.unban',
      'problems.delete',
      'categories.delete',
      'submissions.rejudge',
      'settings.update'
    )
  )
);
CREATE INDEX audit_logs_admin_id_idx ON audit_logs(admin_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at);
CREATE INDEX audit_logs_action_idx ON audit_logs(action);
```

索引选择：admin_id / created_at / action 三列独立索引，覆盖三种最常见筛选模式。复合索引留给后续优化（如 `(admin_id, created_at DESC)` 用于"某管理员最近活动"）。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| ALS 缺失导致 500 | logAudit 调用前必过 adminMiddleware → 自动注入；service 单元测试用 enterTestContext |
| 审计写入热点 | admin 操作非高频；后续可加批量 INSERT 优化 |
| 90 天 retention 误删 | 保留天数可配置（env）；后续可加归档策略（先导出再删） |
| root 用户审计误隐藏 | 列表 UI 提供"显示 root"开关 |
| 测试间审计污染 | 每个测试 beforeEach 清空 audit_logs 表 |

## 验证

- `deno task test`：新增 ~10 个测试 + 5 处既有测试扩展
- 端到端：admin ban 用户 → 查 `/admin/audit-logs` → 见到对应记录
- 清理任务：临时设 `AUDIT_LOG_RETENTION_DAYS=0` + 插入一条 `created_at < now-1s` 的记录，验证删除生效
- UI smoke：`/admin/audit-logs` 页面渲染正常，筛选交互可用