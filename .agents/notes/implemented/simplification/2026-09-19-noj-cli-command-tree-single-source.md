# Agent Note: noj-cli 命令清单收敛为单一事实源并新增防漂移门禁

Status: implemented

## Problem

noj-cli 的顶层命令清单此前维护在**至少 4 处**：`cli.ts` 的 `printHelp()`
委托的 `help.ts` 分区常量、`cli.ts:1064`（`stack` 子命令 help 字符串）、
`cli.ts:1567`（`renderProductionCommandHelp` 的 `backup` 摘要）、
`cli.ts:1640`（`renderMaintainHelp` 的 `maintain backup` 子命令列表）。
副本已经漂移：真实可用的 `noj-cli backup list` / `backup prune`（`cli.ts:1370`、
`:1399` 的 `case "list"` / `case "prune"`，见 #515 P6）在生产命令的
命令级 help 与 `maintain` 的列表里均告缺失，只有 `help.ts:52` 是对的。

根因不是某处笔误，而是「同一事实有多个副本」这一结构。只修文案下一次仍会漂移。

## Decision

新增 `noj-cli/src/commands.ts` 作为**唯一**命令树声明
（`CommandSpec` / `COMMANDS` / `renderCommandList()` / `declaredTopLevelNames()`），
内容以 `cli.ts` 的**实际分发代码**逐条核对（`PRODUCTION_COMMANDS`、
`dispatchCommand` 的 `switch` 分支、`problem`/`problems`/`stack` 特判、
`container.ts` 的 Tier 3 前缀），而非以旧 help 文案为准。
`cli.ts:printHelp()` 改为直接委托 `renderCommandList()`；
`help.ts` 删除 `HELP_SECTIONS`/`renderHelp` 及 5 个分区常量，
只留下各子命令共用的 `renderCommandHelp` 原语。

**门禁（本任务的核心产出）**：`cli.ts` 新增导出
`dispatchableTopLevelNames()`，其内容**不是**第二份手写清单，而是从三处既有
判定现场提取：`PRODUCTION_COMMANDS`、`CONTAINER_COMMANDS` 的顶层名，
以及 `topLevelDispatchNames()`——后者用行首锚定正则从本文件
`dispatchCommand` 函数体的源码中抓取 `case "..."` 标签与
`command === "..."` 特判。`commands_test.ts` 断言
`declaredTopLevelNames() ⊆ dispatchableTopLevelNames()`。

`mod.ts` 补上 T2–T7 新模块的再导出（`core/config-schema.ts`、
`core/env-file.ts`、`core/state.ts`、`output/render.ts`、`commands.ts`），
使 `deno check src/mod.ts` 真正类型检查它们（T6 评审的 carry-forward）。

## Alternatives considered

在 `commands.ts` 内再写一份「可处理命令」字面量集合：这正是原始缺陷的形态——
门禁会与被门禁的对象一起漂移，且漂移时两边同时变红或不红，门禁形同虚设。

用 `import.meta.main` 之外的运行时反射（如劫持 `dispatchCommand` 逐个试调用）：
需要构造合法 ctx/deployDir 才能到达 switch，且会执行真实副作用（Docker/bash），
不适合单测；源码提取是无副作用且对「新增 case」即时敏感的静态方案。

引入 Cliffy 的 command 对象作为事实源：spec §5 明确 Cliffy 迁移在 T23 之后，
本任务不得引入。

## Consequences

help 文案与实现不再可能单向漂移：新增命令却未实现、或删除实现却未清理 help，
`commands_test.ts` 立即失败（已用三次植入漂移验证：删除 `prune`、
注入 `frobnicate`、重命名 `case "run-server"`，各自都被对应断言抓住）。
`cli.ts` 内不再有任何顶层命令名清单副本。

代价与残留风险：(1) 源码提取依赖行首锚点
`^export async function dispatchCommand(` 与 4 空格缩进的 `case` 标签；
锚点失效时返回空集，主门禁会立刻变红而非静默通过，但错误信息指向「help 漂移」
而非「提取器坏了」——需要读注释才能定位。(2)
`renderProductionCommandHelp`/`renderDeployHelp`/`renderMaintainHelp` 三处
**命令级** help 文案仍是手写的，本任务按 brief 明确不改（T23 处理）；
它们与 `commands.ts` 的漂移目前不受门禁保护。
