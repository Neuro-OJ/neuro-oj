# Agent Note: Markdown 链接门禁

Status: implemented

## Problem

仓库 Markdown 文档存在死链和坏锚点，8 月审计已发现多例；没有机器检查，文档搬家后容易再次漂移。

## Decision

新增 `scripts/verify-md-links.ts`，扫描仓库 Markdown 的相对链接与锚点，检查目标文件和标题锚点是否存在。

- 排除 `node_modules`、`.nuxt`、`.output`、`dist`、`.git`、`.claude`、`.opencode`、`.worktrees`、`vendor`、`coverage`、`superpowers`（历史设计/计划文档不参与实时链接校验）。
- 目录链接视为有效；带锚点的目录链接要求存在 `index.md`。
- 修复当前 5 个真实死链：`scripts/dev/README.md`、`noj-docs/docs/operators/judge-workers.md`、`production-deploy.md`、`intro/faq.md`、`system/storage.md`。
- CI 新增 `md-links-check` job，全仓库运行该脚本。

## Alternatives considered

- 使用 VitePress 内置 dead-link 检查：只覆盖 noj-docs，不覆盖根目录和 scripts 文档。
- 直接允许所有死链并靠人工维护：无法阻止漂移。
- 不排除 `docs/superpowers`：历史计划文档大量引用“未来文件”，会持续误报。

## Consequences

- 全仓库 Markdown 死链在 CI 被拦截。
- 历史设计/计划文档不参与校验，避免误报；正式文档必须保持链接有效。
- 脚本 slug 规则与 VitePress 可能不完全一致，后续若发现锚点误报可补充显式 `{#id}` 或调整 slug 规则。
