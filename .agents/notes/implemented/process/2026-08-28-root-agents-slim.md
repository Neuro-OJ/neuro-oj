# Agent Note: 根 AGENTS.md 瘦身

Status: implemented

## Problem

根 `AGENTS.md` 从 934 行膨胀到约 50KB，包含大量本应属于模块 `CLAUDE.md`、`noj-docs` 和 `docs/engineering/` 的详细内容。AI 每次加载根文档都消耗大量上下文，且详细内容容易与模块文档漂移。

## Decision

将根 `AGENTS.md` 重写为“规则 + 链接”的入口文档，行数从 934 行降至 374 行（减少约 60%）。

- 架构、技术栈、数据库、安全、测试、故障排查等详细内容下沉到：
  - 各模块 `CLAUDE.md`
  - `noj-docs/docs/system/architecture.md`
  - `noj-docs/docs/system/security.md`
  - `docs/engineering/development.md`
  - `docs/engineering/testing.md`
  - `docs/engineering/defensive-patterns.md`
- 保留红线、编码规范、检查清单、贡献流程、OpenSpec、Agent Notes 等必须常驻上下文的规则。

## Alternatives considered

- 不重写，继续在根文档累积：上下文负担持续增加，漂移风险更大。
- 只删除部分章节：无法达到 40% 以上的缩减目标，且结构仍混乱。
- 拆成多个根文档：会增加查找成本，不如保留单一入口 + 链接。

## Consequences

- 根文档加载成本显著降低。
- 详细内容有明确归属，减少重复维护。
- 需要确保链接持续有效，由 `scripts/verify-md-links.ts` 在 CI 检查。
