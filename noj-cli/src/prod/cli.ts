/**
 * 生产命令的 CLI 接线层（T24）：参数解析 → 调用原生实现。
 *
 * ## 本模块存在的唯一理由（R1 收口）
 *
 * T12–T21 交付了全部生产命令的**原生实现**（`prod/lifecycle.ts`、`prod/backup/*`、
 * `prod/drill/*`、`prod/schedule.ts`、`prod/judge/*`），但它们此前**没有接线**：
 * `cli.ts` 把 `PRODUCTION_COMMANDS` 整体转发给 `bash production.sh`
 * （旧 `production.ts:112`）——那是 `noj-cli/src` 内**唯一**的 R1 违例，
 * 也是"纯 TS 重写"最后一块非 TS 拼图。
 *
 * 本模块把那层转发换成真实调用：
 *
 * ```text
 * 旧：noj-cli status → bash <dir>/scripts/deploy/production.sh status → deploy.sh
 * 新：noj-cli status → prod/lifecycle.ts:status → docker compose ps
 * ```
 *
 * ## 边界
 *
 * 1. **只解析参数与装配依赖**：命令语义一律在 `prod/` 的原生实现里，本模块不复制
 *    任何判定（例如"已 running 时 up 是 no-op"只在 `lifecycle.ts`）。
 * 2. **一切外部访问可注入**：`runner`/`io`/`fetcher`/`isTty` 都可替换，因此
 *    `cli_test` 断言"调到原生实现且不 spawn bash"时不起容器。
 * 3. **`--json` 由原生实现负责**：它们已实现 T6 契约（stdout 只含 JSON），
 *    本模块不得再把人类文字写进 stdout。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

// 按职责拆分到同目录 `commands/`，本文件保留为门面（对外导出集合不变）：
// - `commands/types.ts`：`ProdCliDeps` / `ProdCliResult`
// - `commands/args.ts`：参数解析辅助（`parseProdArgs` 等）
// - `commands/deps.ts`：依赖装配与数值/口令解析
// - `commands/check.ts`：`check` / `verify`
// - `commands/lifecycle.ts`：`install` / `status` / `start` / `stop` / `restart` / `logs` / `uninstall`
// - `commands/update.ts`：`update` / `upgrade`
// - `commands/backup.ts`：`backup *` 子命令

export type { ProdCliDeps, ProdCliResult } from "./commands/types.ts";
export {
  flagValue,
  hasFlag,
  hasJson,
  optionalCount,
  parseProdArgs,
  positionals,
  rejectUnimplementedProdFlags,
} from "./commands/args.ts";
export type { ProdArgs } from "./commands/args.ts";
export {
  envNumber,
  numberFlag,
  resolveBackupPassphrase,
} from "./commands/deps.ts";
export { runProdCheck, runProdVerify } from "./commands/check.ts";
export {
  runProdInstall,
  runProdLogs,
  runProdRestart,
  runProdStart,
  runProdStatus,
  runProdStop,
  runProdUninstall,
} from "./commands/lifecycle.ts";
export { runProdUpdate } from "./commands/update.ts";
export {
  type BackupCreateCliOptions,
  normalizeDir,
  runBackupCreate,
  runBackupList,
  runBackupPrune,
  runBackupRestore,
  runBackupSchedule,
  runBackupVerify,
} from "./commands/backup.ts";

export { gpgDecrypt, untarZst } from "./gpg-tar.ts";

/** 供测试引用（避免重复字面量）。 */
export { DEFAULT_UPDATE_REPOSITORY } from "./commands/lifecycle.ts";
