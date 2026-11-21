# Agent Note: openspec 历史提案收敛到 dev-docs

Status: implemented

## Problem

OpenSpec 框架已在提交 `2b42500b` 移除，`openspec/specs/` 不复存在，但
`openspec/changes/` 仍留下 11 个历史变更目录（55 文件、约 159 KB）：框架已下线，提案
却还挂在仓库顶层，目录语义（「变更提案」）与实际状态（只读历史）不符，`AGENTS.md`
的路由与参考链接也指向一个不再更新的位置。其中 `refactor-core-feature-slices` 仍是
noj-core 结构重构的依据，属于活文档，必须留在可被引用的地方。

## Decision

- 用 `git mv` 拆分迁移以保留历史：`refactor-core-feature-slices/` 移到
  `dev-docs/refactor/core-feature-slices/`（活文档区）；其余 10 个目录原样移到
  `dev-docs/archive/openspec-changes/<原名>/`；`openspec/` 空目录删除。
- 更新指向旧路径的 Markdown 链接：根 `AGENTS.md`、`noj-core/AGENTS.md`、两处知识图谱
  README。`AGENTS.md` 已改为「禁令 / 命令 / 路由」精简版，只改路径，结构与预算不动。
- `dev-docs/engineering/module-boundaries.json` 的 `docPrefixes` 去掉 `openspec/`
  ——目录不存在后它是死规则。
- `dev-docs/README.md` 登记 `refactor/`（活文档）与 `archive/openspec-changes/`
  （归档）；`dev-docs/archive/openspec-changes/README.md` 写明只读，以及新变更写
  `.agents/notes/` 与 `dev-docs/`。

## Alternatives considered

- 直接删除 `openspec/changes/`：会丢掉 10 个提案的决策依据（当时为什么这么做、
  否掉了什么），而 git 历史里旧路径已随目录消失，事后检索成本更高。
- 全部平铺进 `dev-docs/`：活跃的重构依据会与历史提案混放、被归档文档淹没，故按
  「活 / 死」拆成 `refactor/` 与 `archive/openspec-changes/` 两处。
- 保留 `openspec/` 空壳只放一行指路 README：仍需长期维护一个只有指路作用的目录，
  `docPrefixes` 与 CI 文档选择逻辑也得继续保留死规则。

## Consequences

- 仓库顶层不再有 `openspec/`；`verify-md-links` 与 `check-module-boundaries` 通过，
  历史提案仍可按原目录名定位。
- `dev-docs/archive/superpowers/`（时点快照）、`dev-docs/audit/`（审计快照）与
  `.agents/notes/`（决策记录）中的历史性 `openspec/` 提及按「只读快照不回溯修改」
  保留；`noj-core` 源码注释里仍有过时的 `openspec/changes/...` 指路（含
  `drizzle/0016-0018`），本轮不清理。
- 归档文档正文不改写，因此这些文件里仍会出现 `openspec/specs/...` 字样——那是发表
  时的事实，不是现行路径。
