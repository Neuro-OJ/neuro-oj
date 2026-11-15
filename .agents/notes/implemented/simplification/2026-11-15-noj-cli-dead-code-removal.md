# Agent Note: 删除 noj-cli 的库入口、未用依赖、死模块与已移除命令兼容层

Status: implemented

## Problem

noj-cli 只以 `deno compile` 单二进制分发，仓库内没有任何模块把它当库引用，但
`src/mod.ts` 维持着 640 行再导出，唯一真实用途是提供 `VERSION`——而该常量停在
`0.10.5`，与 `deno.json` 的 `0.11.0` 不一致，`noj-cli version` 输出错误版本。
`@cliffy/command` 只被一个冒烟测试引用；`runtime/download.ts` 的 noj-server
二进制下载与 `runtime/logfile.ts` 已无调用方。T23 移除的
`doctor`/`deploy`/`stack`/`run-server` 仍保留专门的迁移提示分支、
`REMOVED_COMMANDS` 集合与配套门禁测试。

## Decision

- 删除 `mod.ts`/`mod_test.ts`，新增 `version.ts` 以 JSON 静态导入读取
  `deno.json` 的 `version`，版本号只剩一处事实源；`deno.json` 去掉
  `exports`/`name`，`check` 任务改为 `deno check src/`。
- 移除 `@cliffy/command` 依赖与 `cliffy_smoke_test.ts`（`deno.lock` 由
  `deno install` 重新生成）。
- 删除 `runtime/download.ts`、`runtime/logfile.ts` 及其测试； `prod/release.ts`
  实际用到的标签正则与资产就绪过滤内联为模块私有实现，行为由 `release_test.ts`
  既有用例覆盖。
- 删除已移除命令的分发分支、`removedCommandNotice`、`REMOVED_COMMANDS`，以及
  `PROFILE_AGNOSTIC` 中不存在的 `doctor`/`completions`；这些名字现走通用
  「未知命令」路径（退出码仍为 2）。`commands_test.ts` 的源码提取结束锚点改为
  `cli.ts` 末尾的入口注释。

## Alternatives considered

- 保留 `mod.ts` 只修版本号：仍留下 640
  行无人消费的导出面，且版本号仍需手工同步。
- 保留旧命令迁移提示一个版本周期：T23 至今已跨多个版本，README 仍保留旧 JSON
  文件可删除的说明，CLI 内提示已无必要。

## Consequences

- noj-cli 净删约 1500 行，依赖减少 cliffy 及其 6 个传递包。
- `noj-cli version` 自动跟随 `deno.json`，由 `check-version-consistency`
  统一校验。
- 旧命令不再给出定制替代建议，只提示未知命令与 `--help`。
- 后续简化（profile 机制收敛、命令元数据合并为单表、入口分层合并）另行处理。
