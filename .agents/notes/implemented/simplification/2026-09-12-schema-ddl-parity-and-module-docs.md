# Agent Note: schema-ddl 自动化 parity 与模块文档去重

Status: implemented

## Problem

1. `noj-core/src/shared/db/schema-ddl.ts` 是 Drizzle schema 的**手工 SQL 副本**（供 PGlite 建表），没有任何自动化 parity 校验。本次引入自动化比对后发现**真实漂移**（推翻架构评审初稿"逐表逐列完全一致"的结论）：`roles.is_admin` 是陈旧列（迁移 `0032_giant_callisto.sql` 已 DROP）、`permissions`/`role_permissions`/`user_roles` 三张表被误放在 `SCHEMA_INDEXES` 数组里。漂移的症状是"测试跑在手工 SQL 上、与生产行为不一致"，比测试失败更危险。
2. 模块文档双份维护且已经分叉：`noj-core/AGENTS.md` 与 `noj-core/CLAUDE.md` 是两份独立文件，后者是当前版本（`domains/` 结构），前者停留在 `src/routes/`+`src/lib/` 的旧结构。

## Decision

1. 新增 `noj-core/scripts/check-schema-parity.ts`（置于 noj-core 内以复用其导入映射）：以 Drizzle schema 为事实源，解析 `SCHEMA_DDL` 的 `CREATE TABLE` 取表/列，双向比对；4 条自检（两侧解析到 0 张表/列即失败）。接入 `check-ci.ts`（以 `cwd=noj-core` 调用）。
2. 修掉真实漂移：删除 `roles.is_admin`、把 3 张 RBAC 表移入 `SCHEMA_DDL`（`SCHEMA_INDEXES` 只留索引）。修复后 54 表 / 433 列一致。
3. `noj-core/AGENTS.md` 与 `CLAUDE.md` 收敛为同一份（AGENTS.md 为实体、CLAUDE.md 为 symlink），与 `noj-ui`/`noj-judge` 的既有约定一致。

## Alternatives considered

- 直接改用真实迁移文件驱动 PGlite（删除手工 DDL）：更彻底，但 drizzle 的 PGlite migrator 把整个文件当**预处理语句**发送，遇到多语句迁移直接报 `cannot insert multiple commands into a prepared statement`（已实测），需要自研语句切分执行器，风险与工作量都更大。
- 保留手工 DDL + 只靠人工评审：这正是漂移发生的原因。
- 保留两份模块文档并同步内容：下次仍会分叉。

## Consequences

schema-ddl 漂移从此被 CI 拦截，且门禁的解析器自身也有单测（列注释、约束行、名为 `key` 的列、`CHECK` 内逗号等易错形态）。PGlite 引导逻辑不变（仍依次执行 `SCHEMA_DDL` → `SCHEMA_INDEXES`），表位置调整不影响建表顺序（RBAC 关联表在 `roles` 之后）。
