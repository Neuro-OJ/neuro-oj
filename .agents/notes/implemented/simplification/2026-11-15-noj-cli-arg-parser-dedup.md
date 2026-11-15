# Agent Note: 统一 noj-cli 的旗标解析

Status: implemented

## Problem

noj-cli 有多套功能重叠的旗标解析：

- `parseBackupArgs`（约 200 行）手写了一遍 create / verify / restore / prune / drill
  的全部旗标，但 backup 子命令早已改走 `prod/commands/backup.ts` 的
  `flagValue` / `hasFlag` / `optionalCount`，它只剩 drill 一个调用方，其余字段在生产
  路径上从不被读取，相应测试实际在测死代码；它还不支持 `--rpo-max-hours=24` 这类
  `=` 写法（会被当成位置参数）。
- `util/args.ts` 的 `parseDirArg` 只被 `parseBackupArgs` 使用，`parsePortArg` /
  `validatePort` 已无调用方。
- `cli-commands/args.ts` 的 `parseInstallDirArg` 是 `flagValue` 的逐行复刻，仅报错
  文案不同。

## Decision

- `flagValue`（新增可选的缺值文案参数）、`hasFlag`、`optionalCount` 移到
  `util/args.ts`，作为全 CLI 唯一的旗标取值实现；`prod/commands/args.ts` 只保留生产
  命令专属的 `parseProdArgs`、`positionals`、未实现旗标守卫与 `humanOutput`。
- 删除 `parseBackupArgs` 与 `backup-args.ts`，drill 改用 `prod/commands/drill.ts`
  中基于上述原语的 `parseDrillArgs`（只含 drill 实际使用的字段）；裸 `--keep` 在取
  位置参数前剔除，避免被 `positionals` 当作带值旗标吞掉快照路径。
- `parseInstallDirArg` 改为 `flagValue(args, "--install-dir", <原文案>)`。
- 删除 `parseDirArg`、`parsePortArg`、`validatePort` 及其测试；死字段的解析测试随
  `parseBackupArgs` 删除，`flagValue` 与 `parseDrillArgs` 各补等价测试。

## Alternatives considered

- 把 `problem/command.ts` 的 `parseProblemArgs` 也改用 `flagValue`：它是严格解析器
  （拒绝未知选项、不接受 `=` 写法），改写会改变用户可见行为，保持不动。
- 保留 `parseBackupArgs` 只删死字段：它的取值逻辑仍与 `flagValue` 重复，且
  `=` 写法缺陷仍在，不如直接复用共享原语。

## Consequences

- 带值旗标的解析规则（两种写法等价、缺值报用法错误）只有一处实现。
- drill 现在接受 `--flag=value` 写法；未知 `--xxx` 不再可能被误当作快照路径。
  其余退出码与报错文案不变。
- 新增带值旗标时，除用 `flagValue` 取值外，仍需登记到 `positionals` 的带值清单。
