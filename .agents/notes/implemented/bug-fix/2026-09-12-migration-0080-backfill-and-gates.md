# Agent Note: 修正迁移 0080 的存量库加列并新增迁移安全门禁

Status: implemented

## Problem

`drizzle/0080_woozy_romulus.sql` 由 drizzle-kit 生成为四条 `ADD COLUMN "updated_at" text NOT NULL`（无 DEFAULT、无回填）。四张表（`community_reports` / `community_sanctions` / `ip_bans` / `user_bans`）运行时必有数据，且 `user_bans` 根本没有 `created_at`（时间基准是 `banned_at`）。PostgreSQL 允许空表直接加 NOT NULL 列，因此唯一跑文件迁移的测试（空库上的 `tests/00_migrate_test.ts`）无法发现；只有**存量库升级**会失败，而 drizzle migrator 把整批迁移包在单事务里 → `migrate` 非零退出 → `core` 因 `depends_on: service_completed_successfully` 无法启动 = 全站不可用。

## Decision

1. 0080 就地改为三步式（**不能**用后续迁移修：drizzle 失败即整批回滚，0081 及以后永远不会执行）：加可空列 → 回填（`community_reports`/`community_sanctions`/`ip_bans` 用 `created_at`，`user_bans` 用 `banned_at`）→ `SET NOT NULL`。
2. 新增 `tests/db/migration_0080_backfill_test.ts`：把四张表回退到"0080 之前"的形态并写入代表性数据，然后执行**真实迁移文件里的语句**，断言不报错、回填值取自创建时刻、列确为 NOT NULL（并显式插入 NULL 验证约束生效）。PGlite 与 PG 双模式通过。
3. 新增 `scripts/check-migration-safety.ts` 静态门禁：扫描全部 `drizzle/*.sql`，禁止"向已存在的表加 NOT NULL 列且无 DEFAULT"；带自检（解析不到任何迁移文件/加列语句即失败）。
4. 规则写入顶层 `AGENTS.md` §8.2。

## Alternatives considered

- 新增 0081 修数据：无效，0080 失败会让整批回滚，0081 不会被执行。
- 只依赖人工评审：本次缺陷正是"评审清单没有这一条"漏出来的。
- 用 generated column 或触发器替代：超出缺陷范围，且改动面更大。

## Consequences

迁移在存量库上可安全升级；同类写法从此被静态拦截。门禁自测覆盖了"无分隔标记的多语句块"（38/83 个迁移文件没有 `--> statement-breakpoint`），避免 `ADD COLUMN` 之后的 `CHECK (... IS NOT NULL)` 被误判。
