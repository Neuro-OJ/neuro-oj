# Agent Note: v0.10.6 至 v0.11 逻辑数据库升级工具与运维指南

Status: implemented

## Problem

`v0.11` 在数据库结构与业务语义上对 `v0.10.6` 做了不兼容重构：`0116_peaceful_gorilla_man.sql` 对存量旧 `U` 型题与 `contests` 施加了 `55000` 兼容守卫，`0132_eager_gamma_corps.sql` 要求空库下完成 RBAC 到固定角色的模型切换，且 `schema-compat.ts` 会严格比对 144 条迁移账本的 SHA-256。既有 `noj-cli update` 原地迁移路径无法让 `v0.10.6` 老用户安全升级到 `v0.11`，需要交付一条只读源库、目标库原子提交的可验证升级通道。

## Decision

1. 在 `noj-core/src/shared/db/upgrade-v010/` 实现只读源库 → 全新空 `v0.11` 目标库的逻辑迁移器（严格零业务模块依赖，只依赖标准库、`postgres` 与 `shared/db` / `shared/workspace`）：
   - 源库全程运行于 `SET TRANSACTION READ ONLY`，严禁改写老库；通过 `pg_control_system()` 与端点标识防止源/目标指向同一数据库；用 `readExpectedMigrations` + `validateMigrationLedger` 精确锁定源库为 `0000..0115_ui_submission_mode`、目标库为当前完整 `v0.11` 发布集且除迁移哨兵外所有业务表为空。
   - 目标库单事务完成 53 张已填充核心表与同库 Gateway 表的原子写入：动态排除 `GENERATED ALWAYS` 列；按真实外键拓扑顺序写入并对 `problems ↔ problem_versions`、`submissions/objective_submissions ↔ evaluation_attempts` 实施两阶段循环指针回填（规避 `problems_effective_version_policy_check` 中间态冲突）；跨普通提交与客观题提交统一分配 `receipt_sequence` 并推进 PG 序列；过滤/转换 `moment` 动态、私信相关记录、已移除系统设置和审计动作，并生成 `archivedSummary` 供运维审计；刷新 `user_rankings` 物化视图并在提交前在同事务内核对每张表精确行数。
   - 严格脱离环境变量泄密与测试欺骗：绝不在日志/异常/report 回显数据库 URL 或口令，提供 `--dry-run` 只读预演、零依赖单测与真实 PostgreSQL E2E（`0000..0115 → 0000..0144` + 同库 Gateway）双重验证。
2. 将入口接入 `noj db upgrade-v010`、`scripts/upgrade-from-v010.ts` 与 `deno task db:upgrade-v010`，更新 `preflight-upgrade.ts` 引导提示，并补充运维升级指南与导航入口。

## Alternatives considered

- **修改 `0116` / `0132` 原地执行 DDL**：违背既定迁移账本不可篡改与空库切换守卫约定，一旦在存量库部分失败回滚风险高且破坏已发布镜像兼容契约。
- **使用手工 `pg_dump --data-only` + SQL 修补脚本**：跨表新增非空列、动态重编号 `U` 题、RBAC 权限树闭合计算、循环外键与统一 `receipt_sequence` 在纯 SQL 修补中难以进行事务前只读预览与单元测试验证。

## Consequences

- `v0.10.6` 老实例可通过 `preflight` → 空库初始化 → `noj db upgrade-v010 --dry-run` → `noj db upgrade-v010` 完成可回滚的无损主数据迁移；`U` 题号与下线动态清单通过报告透明输出。
- 后续若 `0144` 之后继续新增非空列，只需维持目标库列内省或按需扩展 `build-plan.ts` 字段映射；所有既有 `drizzle/` 迁移文件与 `_journal.json` 均保持原样未修改。
