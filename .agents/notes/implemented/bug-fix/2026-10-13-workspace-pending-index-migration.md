# Agent Note: 接续迁移恢复两项待处理唯一约束

Status: implemented

## Problem

整合后的真实 PostgreSQL 全量回归中，1949 项通过，一项矩阵并发刷新测试失败：两次相同补算请求生成两条 pending 事件。调查确认生成 SQL 重排时仅保留了 `CREATE INDEX`，漏掉两条 `CREATE UNIQUE INDEX`。Schema 和 PGlite 已定义它们，因此仅列结构 parity 和 PGlite 不能发现真实迁移的缺失。

## Decision

通过标准 `deno task db:generate --custom --name workspace_pending_unique_indexes` 追加 0117，journal 与快照由工具生成，不改已保存 0116。补回原始生成器的两个部分唯一索引：

- `classroom_join_requests_pending_unique`：同班同用户只能有一份 pending 申请，已处理的申请历史保留。
- `education_outbox_pending_refresh_unique`：同域、同任务、同用户范围的 pending 刷新合并，空用户代表整份作业。已处理事件不受此约束限制。

核对原生成 SQL 全部语句分类，遗漏仅为这两项，不删除实际失败或放宽并发语义。运行时刷新仍使用数据库 `ON CONFLICT DO NOTHING`，不新增进程内去重、缓存或重试系统。

## Alternatives considered

- 让测试接受两条事件：掩盖已经确认的合并规则，不采用。
- 增加内存／Redis 去重：数据库已经表达不变量，增加新的共享状态没有必要。
- 修改已保存迁移或手改 journal：使用标准追加迁移，便于 review 并让已验收的本地 0116 库继续升级。

## Consequences

原 0116 与 0117 在新库首次迁移中连续执行，正式部署不会经历缺索引窗口。两个索引与 Drizzle、PGlite 定义一致。真实全量回归失败保留在 `/tmp/noj-root-core-main-final-parallel-20261013.log`，本修复后的标准回归和最终镜像验收另行保存，不以失败前的 1949 项替代修复后结果。
