# Agent Note: Agent Note 制度

Status: implemented

## Problem

NOJ 的架构与流程决策散落在 PR、聊天和设计文档中，缺少“实现后为什么这么选”的持久记录。新成员或 AI 助手重新讨论已定决策的成本很高，且文档漂移难以追溯。

## Decision

新增 `.agents/notes/implemented/` 目录，作为实现期决策记录的唯一存放位置。

- 路径格式：`implemented/<分类>/yyyy-mm-dd-topic-title.md`
- 分类：`feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`
- 文件格式：`# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`
- 非平凡变更必须新增或更新对应记录。
- CI 使用 `scripts/verify-agent-note-format.ts` 校验路径、状态行和必需章节。

## Alternatives considered

- 不引入独立 wiki：决策应与代码同仓库，便于 PR 关联和 diff 审查。
- 不沿用 OpenSpec changes 作为唯一记录：OpenSpec 偏功能提案与行为规范，不适合承载所有实现期权衡。
- 不采用自由格式文档：无格式约束会导致记录质量参差，且无法机器校验。

## Consequences

- 非平凡 PR 需要额外写一条决策记录，短期增加少量成本。
- 长期减少重复讨论和“为什么这样写”的考古成本。
- `scripts/verify-agent-note-format.ts` 成为新的 CI 门禁，需要维护。
