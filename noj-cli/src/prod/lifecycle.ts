/**
 * 生产生命周期命令门面：install / start / stop / restart / status / logs /
 * update / uninstall。
 *
 * 实现按命令族位于 `./lifecycle/` 同名子模块，共享步骤（前置校验、健康等待、
 * 口令装配、uninstall 守卫）在 `./lifecycle/steps.ts`。
 *
 * ## 状态机
 *
 * | 命令 | 如何消费 `prodState` |
 * | --- | --- |
 * | `status` | 由 compose ps 的输出推断 running / partial / stopped |
 * | `start` | `upIsNoOp(当前态)` 为真即 **no-op**（不跑 `up`），否则 `waitForStack` |
 * | `stop` | `downIsNoOp(当前态)` 为真即 **no-op**（不跑 `stop`），否则 `compose stop` |
 * | `restart` | stop → start |
 *
 * `install` **有意不查** `docker compose ps`：用 `waitForStack` 的退出码表达
 * "是否真的起来"。no-op 文案取自 `transition(...).message`，不另写第二份。
 *
 * ## 退出码
 *
 * 0 成功（含 no-op）；1 运行失败（前置校验不过、compose 失败、健康等待失败）。
 * **用法错误 = 2 由 CLI 解析层产出**，命令层不自行判 2。`stop` 如实读
 * `compose stop` 的退出码，失败即 1。
 */

export {
  install,
  type InstallOptions,
  type InstallResult,
  type InstallStep,
  type InstallStepName,
  missingConfigError,
  probeCosign,
} from "./lifecycle/install.ts";
export {
  type LifecycleBaseResult,
  type LifecycleOptions,
  logs,
  type LogsCommandOptions,
  type LogsResult,
  status,
  type StatusResult,
} from "./lifecycle/services.ts";
export { restart, start, stop } from "./lifecycle/start-stop.ts";
export {
  update,
  UPDATE_BACKUP_UNAVAILABLE_HINT,
  UPDATE_UP_TO_DATE_HINT,
  type UpdateBackupContext,
  type UpdateBackupResult,
  type UpdateMigrationContext,
  type UpdateOptions,
  type UpdateResult,
  updateSuccessHint,
  type UpdateSyncContext,
  upgrade,
} from "./lifecycle/update.ts";
export {
  uninstall,
  UNINSTALL_ALL_CANCELLED_HINT,
  UNINSTALL_ALL_PROMPT,
  UNINSTALL_ALL_WARNING,
  UNINSTALL_CANCELLED_HINT,
  UNINSTALL_PROMPT,
  UNINSTALL_TTY_HINT,
  UNINSTALL_WARNING,
  type UninstallOptions,
  type UninstallResult,
} from "./lifecycle/uninstall.ts";
