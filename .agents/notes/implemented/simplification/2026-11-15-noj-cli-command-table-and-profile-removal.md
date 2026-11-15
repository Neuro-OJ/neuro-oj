# Agent Note: noj-cli 命令表单一事实源、删除 profile 机制并收拢入口层

Status: implemented

## Problem

T23 收敛为单模态后，`--profile` 只接受 `prod`，profile 探测唯一的实际作用是在
Tier 3 容器命令前再找一次安装目录，而 `dispatchContainer` 随后又用
`findProductionDir` 定位一次；探测更严格，反而挡住了「按已安装二进制位置定位」的
兜底路径。命令元数据散落在 6 处（`COMMANDS`、`PRODUCTION_COMMANDS`、
`CONTAINER_COMMANDS`、`KNOWN_TOP`、`PROFILE_AGNOSTIC`、生产命令 help
的摘要表）， 为防它们漂移又维护了一组从 `cli.ts` 源码提取 `case`
的门禁测试。入口代码分散在 `src/` 顶层 8 个小文件与 `cli-commands/`
之间，`cli.ts` 只是再导出门面， `run.ts` 与 `cli.ts` 互相引用。

## Decision

- 删除 `profile.ts`、`cli-commands/profile.ts`、`--profile` 旗标与
  `PROFILE_AGNOSTIC`；目录定位只由 `prod/install-dir.ts` 的 `findProductionDir`
  负责，并直接抛 `ProductionDirError`（退出码 1、不提示 `--debug`）。
- `commands.ts` 的 `COMMANDS` 成为唯一事实源：顶层带 `tier`，子命令可声明
  `container`，`maintain` 声明 `noDeps`；`PRODUCTION_COMMANDS`、`KNOWN_TOP`、
  `CONTAINER_ROUTES` 均由它推导，生产命令 help 的摘要与子命令列表也取自它。
- 源码提取式防漂移门禁换成行为门禁：对每个顶层命令及别名执行 `--help`，断言 返回
  0 且不落入「未知命令」。
- 入口层收拢：`run()` 与 `dispatchCommand()` 合并进 `cli.ts`（去掉再导出门面）；
  Tier 3 执行原语合并为 `prod/tier3.ts`，安装目录识别移到
  `prod/install-dir.ts`；`exit_codes.ts`、`backup-args.ts` 与 `help.ts` 并入
  `cli-commands/`；删除 `registry.ts` 及无调用方的 `parsePort`、
  `firstPositional`、`removeFirstPositional`。
- 顺带修复 Tier 3 help 用法行带出 `--help` 的问题。

## Alternatives considered

- 保留 `--profile prod` 作为无操作旗标：文档从未推荐，保留只会延续一个没有语义的
  概念。
- 保留源码提取门禁：命令表推导后分发与声明不可能漂移，行为门禁覆盖剩余风险
  （声明了但分发路径不处理）。
- 把入口整体迁到新的 `cli/` 目录：只换目录名不减层级，徒增改动面。

## Consequences

- 传入 `--profile` 不再被识别，会作为普通参数交给子命令。
- Tier 3 命令在安装目录外执行时退出码由 2 变为 1，与生产命令一致；可通过已安装
  二进制所在位置找到安装目录。
- `tier3` 分区的裸顶层名（如 `noj-cli db`）现在路由进容器，由容器内 CLI
  打印用法； `db --help` 等由 noj-cli 回答。
- 新增命令只需在 `COMMANDS` 登记一处。
