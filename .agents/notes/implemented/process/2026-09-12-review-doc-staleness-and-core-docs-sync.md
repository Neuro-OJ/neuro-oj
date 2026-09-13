# Agent Note: 评审文档时效约定与核心模块文档纠错

Status: implemented

## Problem

文档与实现脱节会误导后续评审与 AI 助手（本次评审的初始假设就来自过期文档）：`architecture-review-2026-09-01.md` §4.2 声称"无前端单元测试""composable 命名 camelCase/kebab-case 混用"，而实际已有 30 个前端测试文件并接入 CI、31 个 composable 全部 camelCase；`noj-core/CLAUDE.md` 声称 38 张表（实际 54）、`users.role` 列"保留为 deprecated"（实际已删除）；`AGENTS.md` §7.1 允许直接推送 main，而模块文档写"禁止直接推送到 main"（直接矛盾）；`ROADMAP.md` Phase 3 把已实现的监控/日志/CI-CD/备份都列为未完成。

## Decision

1. **评审/审计类文档是时点快照，不回溯修改结论**；被推翻时在顶部加「修订指针」指向最新结论（已在 09-01 评审顶部实施）。
2. 把该约定与"计数类陈述不写死、改由门禁基线承载"写入 `dev-docs/engineering/README.md`。
3. 逐项纠错：表数量 38→54；`users.role` 说明改为"已删除，管理员判定为权限集含 `admin:full_access`"；`roles` 表说明去掉 `is_admin`；noj-ui 测试/命名两处更正（保留"2026-09-12 更正"字样便于对照）；推送策略统一到顶层 `AGENTS.md` §7.1（模块文档改为引用顶层规则，不再重复声明禁止）；ROADMAP Phase 3 已实现项勾选。
4. 在 09-12 评审文档中补「§0 修复状态」表（逐条给出落地内容与验证方式），并记录本次执行中**推翻了自己初稿**的两点（schema-ddl 漂移、路由目录伪造条目规模）。

## Alternatives considered

- 直接改写旧评审的结论：会破坏"当时判断了什么"的可追溯性，也让后续读者无法判断哪些结论已被推翻。
- 只改代码不改文档：文档漂移会继续误导下一轮评审（本次即如此）。
- 把推送策略统一为"禁止直接推送 main"：与顶层 AGENTS.md 及实际工作流（main 上直接开发）不符，且顶层文档明确声明自己是规则入口。

## Consequences

文档与实现的关键计数/结论对齐；新评审结论有了明确的时效标注约定。`noj-core/AGENTS.md`/`CLAUDE.md` 归一后，AGENTS.md 成为唯一实体（含本次新增的多副本约束与迁移安全规则）。
