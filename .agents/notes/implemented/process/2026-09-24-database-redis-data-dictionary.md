# Agent Note: 参考区新增《数据库与 Redis 数据字典》

Status: implemented

## Problem

运营者需要一份可查的字段级参考资料，用来理解 Neuro OJ 在 PostgreSQL 中各表、
各列的含义，以及 Redis 中各键族（评测队列、限流、JWT 撤销、LLM 额度等）的类型、
TTL 与作用。此前这些信息只散落在源码注释、模块 `CLAUDE.md` 与设计文档中，没有
面向运维的单页入口，排查问题时需要在多个文件间来回跳转。

同时，LLM 网关的 `llm_providers.encrypted_api_key` 等凭据类字段属于高危对象，
需要一个显著、可复用的「DANGER ZONE」视觉标记，避免运营者在不了解风险的情况下
导出或误改。

## Decision

在 `noj-docs` 的「参考」分区新增 `reference/data-dictionary.md`，提供：

- **页首免责声明**：明确本文档为 best-effort 运维参考，**不保证与当前代码一致**、
  会随开发变动且不另行通知，执行任何 DB/Redis 操作前必须二次复核并备份。
- **全量列级字典**：按业务域覆盖 noj-core 的 59 张表 + noj-llm-gateway 的 3 张
  表（逻辑所有权归网关，与 core 同库）+ `user_rankings` 物化视图 + 迁移记账表。
- **Redis 键族**：逐族给出键模式、数据结构、写入方、TTL、作用与「能否删除」，
  覆盖评测 MQ、公平调度占用、跨副本 SSE 事件、异步消费者、登录/搜索/加固限流、
  竞赛提交预算、JWT 撤销与 LLM 限流额度。
- **DANGER ZONE 一览 + 行内标记**：`llm_providers` 等表在标题旁使用自定义徽标
  `.noj-danger-zone`，敏感列在字段表中以 `.noj-danger-col` 红字 + ⚠ 前缀标出。

样式落在既有的 `theme/styles/custom-block.css`（复用 danger 色变量，亮/暗两套，
圆角 3px 遵循品牌 token），不新增 CSS 文件、不改 `theme/index.ts`。

## Alternatives considered

- **不做免责声明只写字典**：否决。数据字典天然会与快速演进的 schema 漂移，不写
  免责声明会让运营者误以为它是契约，进而直接照做高风险操作。
- **自动生成（从 drizzle 快照 / schema.ts 反射）**：否决。生成物难以承载「作用」
  「风险等级」「能否删除」这类语义，也无法表达 Redis 键族（Redis 无 schema），
  且会引入维护成本与 CI 门禁。当前定位是手写运维参考。
- **用 `<Badge>`/纯 emoji 做危险标记**：否决。VitePress 原生没有 DANGER ZONE 徽标，
  纯 emoji 视觉权重不足；自定义样式类更可控且符合品牌设计 token。
- **放入 `operators/` 而非 `reference/`**：否决。这是「查询型」参考资料，与术语表、
  结果状态同属参考区，放参考区更符合既有信息架构。

## Consequences

- 运营者获得单页字段级参考；DANGER ZONE 对象有了统一、醒目的标记。
- 文档是手写的，**存在与代码漂移的风险**：页首免责声明与「改动前复核」小节显式
  承接了这一点；后续 schema 变更时需人工同步（非门禁强制）。
- 新增的自定义样式类（`.noj-danger-zone` / `.noj-danger-col`）可被其他页面复用。
- 未改动任何 schema、迁移或 Redis 代码，对运行时零影响。
