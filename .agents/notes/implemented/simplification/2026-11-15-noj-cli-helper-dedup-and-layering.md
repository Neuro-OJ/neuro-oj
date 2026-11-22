# Agent Note: 合并 noj-cli 重复工具函数并收拢生产命令分层

Status: implemented

## Problem

noj-cli 的生产命令有两类冗余：

- 同一个小工具被就地复制了多份：`isFile` / `pathExists` 在 `lifecycle/steps.ts`、
  `drill/plan.ts`、`backup/container-paths.ts`、`judge/actions.ts`、`config/checks.ts`
  中各写一份；`readEnvValues`（含"文件缺失视为空"的变体）分散在 5 处调用点；
  `judgeEnabledFrom` 有两份；drill 自带一套与 `backup/data_restore.ts` 完全同形的
  `compose` / `startOneShotService` / `feedFileToCompose`，`drillComposeArgs({...})`
  的同一组参数字面量重复 5 次；`drill.ts` 的 `removeQuietly` 名不副实（失败照样抛错）。
- 分层多了一层转发：`prod/cli.ts` 是纯再导出门面，`cli-commands/production.ts`
  （606 行）除顶层分发外还承载 judge / backup 子命令分发与 drill 执行，三处各自
  内联同一个"`--json` 时人类输出走 stderr"的 `say` 闭包；`lifecycle/context.ts`
  反向导入自身门面 `../lifecycle.ts`。

## Decision

- `util/fs.ts` 提供唯一的 `isFile`（原 `fileExists` 改名）与 `pathExists`；
  `core/env-file.ts` 提供 `readEnvValues` 与 `readEnvValuesOrEmpty`；
  `judgeEnabledFrom` 只留在 `config/checks.ts`。`config/checks.ts` 中语义不同的
  socket 判定改为私有 `socketPathExists`。
- `backup/data_restore.ts` 导出 `ComposeTarget` 与 `compose` / `startOneShotService` /
  `feedFileToCompose`；drill 用一个 `drillTarget()` 适配隔离项目参数后复用这些原语，
  删除本地副本和未用的 `opts` 参数；`removeQuietly` 换成直接 `Deno.remove`。
- 删除 `prod/cli.ts`。judge 子命令分发移到 `prod/commands/judge.ts`（`runProdJudge`），
  backup 子命令分发并入 `prod/commands/backup.ts`（`runProdBackup`），drill 执行移到
  `prod/commands/drill.ts`（`runBackupDrill`），`backup-args.ts` 随之移到
  `prod/commands/`；`formatBytes` 移到 `prod/commands/backup.ts`，`say` 闭包统一为
  `prod/commands/args.ts` 的 `humanOutput(json)`。`cli-commands/production.ts`
  只剩安装目录定位与顶层分派（169 行）。
- drill 的口令解析改用与其它 backup 子命令相同的 `resolveBackupPassphrase` +
  `readConfiguredPassphrase`（移到 `prod/commands/deps.ts`），删除重复的
  `resolveBackupPassphraseForDir`；优先级不变（旗标 > 进程环境 > `.env.prod`）。
- 行为不变：退出码、输出通道与文案保持原样。drill 入口里不可达的 `--help` 分支
  （顶层 `dispatchCommand` 已先处理）一并删除。

## Alternatives considered

- 同时删除 `prod/lifecycle.ts` / `prod/config.ts` 门面：二者承载状态机与校验约束的
  模块级文档，且对外导出集合稳定；只修正子模块反向导入自身门面的一处。
- 把 backup 分发单独成文件：`backup.ts` 合并后 725 行，仍远低于 1200 行阈值，
  按命令族一文件更易定位。
- 同时合并 `parseBackupArgs` 与 `prod/commands/args.ts` 的旗标解析：属于另一批
  （重复参数解析器）的范围，本次只搬位置不改语义。

## Consequences

- 生产命令的分层为"入口 `cli.ts` → `cli-commands/production.ts` 定位目录与分派 →
  `prod/commands/<命令族>.ts`"，新增子命令直接放进对应命令族文件。
- 新代码判断文件存在性、读 `.env`、调 compose 时应复用上述唯一实现，不再就地复制。
- 测试从 `prod/commands/*` 直接导入；动态导入不受 `deno check` 覆盖，删除模块时
  需额外 `rg 'import\("'` 检查。
