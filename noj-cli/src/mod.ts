/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.1.0";

// 配置模型（P0）
export * from "./config/types.ts";
export { loadDeployment } from "./config/load.ts";
export { saveDeployment } from "./config/save.ts";
export { validateConfig } from "./config/validate.ts";
export { resolveComponentEnv } from "./config/merge.ts";
export {
  DEPLOY_FILE,
  DEPLOY_FILE_MODE,
  SECRETS_FILE,
  SECRETS_FILE_MODE,
} from "./config/io.ts";

// 状态机与工具（P0）
export { transition } from "./state/machine.ts";
export type { DeployAction, TransitionResult } from "./state/machine.ts";
export { findDeployDir } from "./util/find_deploy_dir.ts";

// doctor（P1）
export type {
  CmdResult,
  DiskInfo,
  MemInfo,
  SystemProbe,
} from "./doctor/probe.ts";
export { realProbe } from "./doctor/probe.ts";
export type { CheckResult } from "./doctor/checks.ts";
export { runDoctor } from "./doctor/doctor.ts";
export type { DoctorOptions, DoctorReport } from "./doctor/doctor.ts";
export { formatReport } from "./doctor/report.ts";

// TUI（P1）
export type { PromptIO } from "./tui/io.ts";
export { realIO } from "./tui/io.ts";
export { confirm, input, secretInput, select } from "./tui/widgets.ts";

// init（P1）
export { devTemplate, prodTemplate } from "./init/templates.ts";
export type { ProdTemplateOptions } from "./init/templates.ts";
export { generateSecrets, randomKey } from "./init/secrets.ts";
export { runInitWizard } from "./init/wizard.ts";
export type { InitOptions } from "./init/wizard.ts";

// runtime（P2）
export type {
  CmdResult as RuntimeCmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "./runtime/command.ts";
export { realRunner } from "./runtime/command.ts";
export { fileExists } from "./util/fs.ts";
export { pidPath, readPid, removePid, writePid } from "./runtime/pidfile.ts";
export {
  processLaunch,
  startManagedProcess,
  stopManagedProcess,
} from "./runtime/process.ts";

// deploy（P2）
export {
  COMPOSE_FILE,
  ensureComposeFile,
  renderCompose,
} from "./deploy/compose.ts";
export { dockerDown, dockerPs, dockerUp } from "./deploy/docker.ts";
export { downIsNoOp, nextState, upIsNoOp, writeState } from "./deploy/state.ts";
export {
  deployDown,
  deployRestart,
  deployStatus,
  deployUp,
} from "./deploy/deploy.ts";
export type {
  ComponentStatus,
  DeployOptions,
  DeployStatusReport,
} from "./deploy/deploy.ts";

// util（P3）
export { colorFor, prefixLine, RESET } from "./util/color.ts";

// runtime（P3）
export { followLogFile, logPath, readRecentLog } from "./runtime/logfile.ts";

// maintain（P3）
export { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
export type { LogsOptions, ModuleLogs } from "./maintain/logs.ts";
export {
  configCheck,
  configSet,
  configShow,
  maskSecrets,
  parseConfigValue,
  setByPath,
} from "./maintain/config.ts";

// maintain/backup（P4）
export {
  fileSha256Hex,
  realDriver,
  sha256Hex,
} from "./maintain/backup_driver.ts";
export type { BackupDriver, DumpEntry } from "./maintain/backup_driver.ts";
export {
  backupCreate,
  backupDrill,
  backupRestore,
  backupVerify,
  defaultBackupDir,
  resolvePassphraseFile,
  snapshotFileName,
  writeSha256Sums,
} from "./maintain/backup.ts";
export type {
  BackupCreateOptions,
  BackupDrillOptions,
  BackupRestoreOptions,
  BackupVerifyOptions,
  Manifest,
  VerifyReport,
} from "./maintain/backup.ts";

// maintain/reset（P4）
export { maintainReset } from "./maintain/reset.ts";
export type { ResetOptions } from "./maintain/reset.ts";
