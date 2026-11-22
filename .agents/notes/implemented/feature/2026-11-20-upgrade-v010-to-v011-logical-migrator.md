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

3. 复审修订（2026-11-20）：
   - **目标库初始化**：Gateway `migrate-cli.ts` 新增 `--schema-only`（不写默认配额），`TARGET_NOT_EMPTY` 给出修复提示；PG 测试经运维同一入口 `deno task db:migrate --schema-only` 初始化目标库。
   - **访问边界**：已发布私有题与非公开/邀请/口令比赛在规划阶段（含 dry-run）以 `ACCESS_DECISION_REQUIRED` 阻断，必须显式 `--private-problems disable|expose` / `--restricted-contests expose`；`disable` 写入绑定与历史的 `disabled_at`，经 `evaluateProblemAccess` 验证匿名与非所有者均拒绝；处置清单进入 `archivedSummary`（不含口令）。
   - **数据一致性**：`sse_events` 显式 ID 写入后推进 serial；引用已删除题目的 `submission_job_items` 绑定置空，非 `failed`/`skipped` 转 `skipped` + `UPGRADE_PROBLEM_DELETED` 并入 `orphanJobItems`；公告迁入为实例级 `domain_id=NULL`（与 `0118` 一致）；`exact` 绑定历史 `answer_version_id` 取 `required_version_id`（与 `0116` 回填一致）。
   - **独立 Gateway**：源 Core 库有默认模型/别名而目标库无同库 Gateway 表时要求 `NOJ_UPGRADE_GATEWAY_URL`（否则 `GATEWAY_TARGET_REQUIRED`），在 Core 提交前写入独立 Gateway 库并读回比对，冲突拒绝且 Core 回滚；报告输出 `gateway.standalone.verified`。
   - **运维文档**：连接串只经环境变量传入（`deno task` 会回显参数、严格解析拒绝 `--`）；区分 Compose 内置库（新建库 + 切换 `.env.prod` 的 `POSTGRES_DB`，`--no-deps` 跳过 `init system`，回滚改回旧库名）与外部数据库（改 `DATABASE_URL`）。

## Alternatives considered

- **修改 `0116` / `0132` 原地执行 DDL**：违背既定迁移账本不可篡改与空库切换守卫约定，一旦在存量库部分失败回滚风险高且破坏已发布镜像兼容契约。
- **私有题/邀请赛自动映射为 v0.11 的 `members` 可见性或私有比赛**：v0.11 主域对已发布启用绑定不执行 `visibility` 校验、比赛无邀请语义，静默映射会把受限内容公开，故改为预检阻断 + 显式处置。
- **独立 Gateway 仅靠文档手工 SQL 转移默认模型**：易漏且无法校验，改为迁移器内置转移与读回比对。
- **使用手工 `pg_dump --data-only` + SQL 修补脚本**：跨表新增非空列、动态重编号 `U` 题、RBAC 权限树闭合计算、循环外键与统一 `receipt_sequence` 在纯 SQL 修补中难以进行事务前只读预览与单元测试验证。

## Consequences

- `v0.10.6` 老实例可通过 `preflight` → 空库初始化 → `noj db upgrade-v010 --dry-run` → `noj db upgrade-v010` 完成可回滚的无损主数据迁移；`U` 题号与下线动态清单通过报告透明输出。
- 升级流程新增两个必需决策参数与（独立 Gateway 部署时）一个连接串环境变量；未决策时 dry-run 即失败，避免静默扩大访问面。
- 后续若 `0144` 之后继续新增非空列，只需维持目标库列内省或按需扩展 `build-plan.ts` 字段映射；所有既有 `drizzle/` 迁移文件与 `_journal.json` 均保持原样未修改。
