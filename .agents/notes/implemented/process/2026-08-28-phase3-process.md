# Agent Note: Phase 3 流程固化

Status: implemented

## Problem

质量门禁需要变成团队日常，而不是一次性改造。

## Decision

完成 Phase 3 基础项：

- PR 模板新增“文档同步、注释契约、测试覆盖、JSDoc”检查项。
- 新增 `scripts/run-quality-audit.ts` 作为月度质量审计入口。
- 新增 `docs/postmortem/README.md` 与 postmortem 模板。

## Alternatives considered

- 不固化流程：门禁会随时间失效。
- 引入复杂审计平台：当前规模不需要。

## Consequences

- PR 默认携带质量检查项。
- 严重事故有标准复盘模板。
- 月度审计有统一入口。
