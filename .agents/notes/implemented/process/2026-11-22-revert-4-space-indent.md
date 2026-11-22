# Agent Note: 撤回 #776 的 4 格缩进，恢复 2 格

Status: implemented

## Problem

#776 把全仓 TS / Vue / JSON 从 2 格改为 4 格（`.editorconfig` + 5 个
`deno.json` 的 `indentWidth`），约 2000 个文件只有格式变化。这项改动没有功能收益，
代价却很明显：

- 和并行 PR 大面积冲突。与 #778 合并时 21 个冲突全部由此产生；
- `.editorconfig` 被 LMCC 扩展的 Prettier 读到，未格式化的模块 CI 直接失败；
- 4 格更容易超出行宽、多出折行，静默跳过扫描器因此漏计；
- #776 是 squash 合并，格式化和目录重组、设计系统改动混在同一个提交里，无法单独登记到
  `.git-blame-ignore-revs`。

TS 社区和 `deno fmt` / Prettier 的默认都是 2 格，`noj-ui` 文档也约定 Vue 用
`deno fmt --unstable-component` 的默认格式。

## Decision

只撤回缩进，保留 #776 的目录重组、设计系统收口和评审修复。

- 删除 `.editorconfig`。`noj-core` / `noj-cli` / `noj-tests` / `noj-llm-gateway` 的
  `indentWidth` 改回 2；`noj-ui` 去掉 `indentWidth`，恢复默认 2 格。
- 按文件精确撤回，不是简单地重跑 `deno fmt`，因为 dprint 不会把 4 格下拆开的行重新合并：
  - 对每个被 #776 改动的文件，若“合并前版本按 4 格格式化”恰好等于“合并后版本”，
    说明改动只有格式，直接取合并前版本，逐字还原（1575 个）；
  - 若还有真实改动（TS / JSON / MD），以“合并前版本的 4 格格式化”为基准做三方合并，
    只撤销格式差异，再按 2 格格式化（92 个）；
  - 三方合并有冲突的（69 个）和有真实改动的 Vue（151 个），直接用 2 格格式化。
- LMCC 扩展恢复到 4 格格式化之前的版本。
- `apiProxyCachePolicy_test.ts` 的 routeRules 截取哨兵改回 `'\n  },'`；重新生成
  `skill.generated.ts`、`problem-templates.generated.ts` 和静默跳过报告（数量仍为 336，基线不变）。

验证：把每个改动过的文件按 #776 的 4 格配置重新格式化，2093 个文件与撤回前的 `main`
逐字一致；唯一例外是上面那个哨兵字符串，属于预期改动。也就是说，这次改动除了缩进以外，
不含任何代码变化。

## Alternatives considered

- 整个 #776 一起 `git revert`：会丢掉目录重组、设计系统门禁和 8 个评审修复，代价过大。
- 维持 4 格：已经发生的成本收不回来，而且以后每个新增的格式化入口（例如 Prettier 读到
  `.editorconfig`）都可能再出问题。
- 只改配置后整体重跑 `deno fmt`：会留下 1108 个只多了折行的文件，blame 和 diff
  噪音仍然存在。

## Consequences

- 与 #776 合并后才开的 PR 会再遇到一次缩进冲突：取 `main` 版本后重跑 `deno fmt` 即可。
- 逐字还原的 1575 个文件，内容与 #776 之前完全一致。不过 `git blame` 默认仍会把这些行
  记到撤回提交上；要让 blame 穿透，需要把撤回提交和 #776 一起加入
  `.git-blame-ignore-revs`，代价是 #776 的真实改动也会被跳过。
- 以后再做全仓格式化，应单独开 PR，用非 squash 方式合并，并登记到 `.git-blame-ignore-revs`。
