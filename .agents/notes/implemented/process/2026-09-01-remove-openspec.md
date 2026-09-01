# Agent Note: 移除 OpenSpec 及其附属技能

Status: implemented

## Problem

OpenSpec 在本仓库形成大量文档负担（约 6.5 万行、145 个主 spec、161 个归档变更），与 `docs/superpowers/` 设计文档/实施计划、`.agents/notes/` 决策记录高度重叠，且未被 CI 强制，维护成本高。团队决定移除 OpenSpec 及相关流程。

## Decision

- 删除 `openspec/` 目录。
- 从 `AGENTS.md` 移除 OpenSpec 技能、命令、目录结构、归档命名、红线、检查清单、工作流和参考文档。
- 更新 `README.md`、PR 模板、E2E paths-ignore。
- 清理源码/脚本中指向 openspec 路径的注释。
- 保留历史审计、旧计划、Agent Notes 中对 openspec 的历史性提及作为上下文。

## Alternatives considered

- 完全保留 OpenSpec 并继续强制：维护成本高，与现有轻量流程重叠。
- 仅降级为可选：仍需维护目录和文档，团队已决定彻底移除。

## Consequences

- 仓库文档体积显著下降，AI 上下文负担降低。
- 功能性变更不再需要先 `/opsx:propose`，改由设计文档 + Agent Notes + PR 评审保证质量。
- 历史 openspec 内容不再更新，仅存在于 git 历史中。
