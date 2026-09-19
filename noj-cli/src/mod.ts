/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.9.5";

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
export {
  DEFAULT_NOJ_SERVER_VERSION,
  ensureNojServerBinary,
  resolveLatestVersion,
} from "./runtime/download.ts";
export { fileExists } from "./util/fs.ts";
export { pidPath, readPid, removePid, writePid } from "./runtime/pidfile.ts";
export {
  processLaunch,
  runServerForeground,
  startManagedProcess,
  stopManagedProcess,
} from "./runtime/process.ts";

// deploy（P2）
export {
  COMPOSE_FILE,
  ensureComposeFile,
  renderCompose,
} from "./deploy/compose.ts";
export {
  dockerDown,
  dockerPs,
  dockerUp,
  dockerUpServices,
} from "./deploy/docker.ts";
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
export {
  COLOR_MODES,
  colorFor,
  type ColorMode,
  parseColorMode,
  prefixLine,
  RESET,
  resolveColor,
} from "./util/color.ts";

// runtime（P3）
export { followLogFile, logPath, readRecentLog } from "./runtime/logfile.ts";

// maintain（P3）
export { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
export type { LogsOptions, ModuleLogs } from "./maintain/logs.ts";
export {
  configCheck,
  configSet,
  configShow,
  maintainVerify,
  maskSecrets,
  parseConfigValue,
  setByPath,
} from "./maintain/config.ts";
export type { VerifyReport as MaintainVerifyReport } from "./maintain/config.ts";

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

// 纯 TS 重写内核（T2–T7）：生产配置 schema / .env.prod 读写 / 状态机 /
// 输出通道 / 命令树。自 T2 起新建的模块，此前未从包入口再导出，
// 导致 `deno check src/mod.ts` 不类型检查它们（T6 评审 carry-forward）。
export {
  ALIYUN_EMAIL_KEYS,
  checkEnvFileMode,
  EMAIL_PROVIDERS,
  emailBranchKeys,
  ENV_FILE_ALLOWED_MODES,
  ENV_KEYS,
  ENV_VALUE_RULES,
  isPlaceholder,
  JUDGE_KEYS,
  judgeEnabledError,
  TENCENT_EMAIL_KEYS,
  validateEnv,
} from "./core/config-schema.ts";
export type {
  EnvKeySpec,
  EnvValueRule,
  FilePermissionVerdict,
} from "./core/config-schema.ts";
export {
  ENV_FILE_MODE,
  parseEnvFile,
  readEnvFile,
  serializeEnvFile,
  writeEnvFileAtomic,
} from "./core/env-file.ts";
// 注意：`transition`/`upIsNoOp`/`downIsNoOp` 已由上文 `state/machine.ts` 与
// `deploy/state.ts` 导出且签名不同，这里显式重命名避免符号冲突
//（`core/state.ts` 提供的是 prod 路径用的 `prodState`）。
export { prodState } from "./core/state.ts";
export {
  downIsNoOp as coreDownIsNoOp,
  transition as coreTransition,
  upIsNoOp as coreUpIsNoOp,
} from "./core/state.ts";
export type {
  DeployAction as CoreDeployAction,
  TransitionResult as CoreTransitionResult,
} from "./core/state.ts";
export {
  displayWidth,
  emitHuman,
  emitJson,
  isJsonMode,
  renderStatus,
  renderTable,
} from "./output/render.ts";
export type { RenderIO, StatusOptions, TableOptions } from "./output/render.ts";
// 品牌语义色（T8）：token → ANSI 映射与降级判定，文档单一事实源见
// dev-docs/design/noj-design-tokens.md 的「CLI / 终端」section。
export {
  createTheme,
  SEMANTIC_ANSI,
  SEMANTIC_TOKEN_NAMES,
  STATUS_SYMBOL,
} from "./output/theme.ts";
export type { SemanticToken, StatusKind, Theme } from "./output/theme.ts";
export {
  COMMANDS,
  declaredTopLevelNames,
  EXIT_CODES,
  findCommand,
  renderCommandList,
} from "./commands.ts";
export type { CommandSpec, Tier } from "./commands.ts";
// bootstrap（T9）：从 GitHub Release 下载 compose 与 example 配置并校验，
// 吸收 install.sh 原先"从源码归档 cp"的职责（spec §3.3 洞 2）。
export {
  downloadReleaseFiles,
  RELEASE_FILES,
  releaseAssetUrl,
  validateRef,
  validateRepository,
  validateTargetDir,
} from "./prod/bootstrap.ts";
export type { DownloadReleaseFilesOptions, Fetcher } from "./prod/bootstrap.ts";
// compose（T10）：prod 侧服务集与 compose 调用封装。生产编排只认仓库内固定的
// docker-compose.prod.yml（T9 下载并校验），**不引入运行时渲染**（spec §3.4）。
export {
  composeArgs,
  composeConfig,
  composeDown,
  composeLogs,
  composePs,
  composeUp,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
  PROD_SERVICES,
} from "./prod/compose.ts";
export type {
  ComposeArgsOptions,
  ComposeLogsOptions,
  ComposeOptions,
  ComposeResult,
  ProdProfile,
  ProdService,
} from "./prod/compose.ts";
// config（T11）：生产配置校验、口令生成、面板探测、镜像验签与交互向导。
// 交互只复用 tui/widgets.ts 与 output/theme.ts；外部命令一律经 CommandRunner
// 注入（cosign/docker/lsof 在测试中零执行）。生命周期动作属 T12–T16。
export {
  backupPassphrasePath,
  checkJudgeSocket,
  checkPortValue,
  checkRequiredValues,
  DEFAULT_BACKUP_PASSPHRASE_FILE,
  DEFAULT_COSIGN_IDENTITY_REGEX,
  DEFAULT_COSIGN_OIDC_ISSUER,
  DEFAULT_IMAGE_REGISTRY,
  DEFAULT_PANEL_COMMAND,
  DEFAULT_PANEL_ROOT,
  DEPLOYMENT_MANIFEST_FILE,
  detectPanel,
  ensureBackupPassphrase,
  generateSecret,
  isIpv4Address,
  isSiteAddress,
  JUDGE_IMAGES,
  PANEL_GUIDANCE_OK_LINE,
  panelGuidance,
  PASSPHRASE_ALLOWED_MODES,
  passphraseFileMode,
  PROD_IMAGES,
  recordDeploymentMetadata,
  runConfigWizard,
  showPanelGuidance,
  verifyImageSignatures,
  wizardNeedsInteractiveInput,
} from "./prod/config.ts";
export type {
  EnsurePassphraseOptions,
  EnsurePassphraseResult,
  EnvValues,
  JudgeSocketOptions,
  JudgeSocketResult,
  PanelMode,
  PanelName,
  PanelPaths,
  PanelProbe,
  PassphrasePathOptions,
  PortCheckOptions,
  PortCheckResult,
  RecordMetadataOptions,
  RecordMetadataResult,
  RequiredValuesReport,
  VerifiedDigest,
  VerifyImageOptions,
  VerifyImageResult,
  WizardOptions,
  WizardResult,
} from "./prod/config.ts";
// lifecycle（T12/T13）：生产生命周期命令入口。install 是**唯一**生产安装路径；
// T13 追加 start/stop/restart/status 并接线 T4 状态机（prodState / transition /
// upIsNoOp / downIsNoOp）。runner / fetcher / IO / 安装目录全部可注入，
// 测试不触网、不起容器。
export {
  install,
  // T14：日志命令（着色契约 + --follow）；reachability 由 mod.ts 的再导出保证。
  logs,
  // 仅为可测而导出：首装报错清单需按 judge 状态条件化（review Minor 2）。
  missingConfigError,
  restart,
  start,
  status,
  stop,
  uninstall,
  // T15：卸载（确认词 + 数据卷安全 + 工作区保护）。确认提示与拒绝文案一并导出，
  // 便于 T24 接线时逐字复用而不是另写一份。
  UNINSTALL_ALL_CANCELLED_HINT,
  UNINSTALL_ALL_PROMPT,
  UNINSTALL_ALL_WARNING,
  UNINSTALL_CANCELLED_HINT,
  UNINSTALL_PROMPT,
  UNINSTALL_TTY_HINT,
  UNINSTALL_WARNING,
} from "./prod/lifecycle.ts";
// lifecycle/steps（T13）：从 lifecycle.ts 抽出的共享编排步骤（compose 的
// wait_for_stack、前置校验、compose 输出/裸子命令原语）。命令入口仍在
// lifecycle.ts；T14–T16 在此追加步骤。
export {
  applyLogsColor,
  assertConfiguration,
  assertRemovableInstallDir,
  checkUninstallDependencies,
  COMPOSE_CONFIG_INVALID_HINT,
  composeOutputText,
  decideLogsColor,
  dockerMissingHint,
  mergeColorSource,
  NGINX_REFRESH_FAILURE_HINT,
  PORT_CONFLICT_HINT,
  prepareAndCheck,
  probeCommandCode,
  removeInstallDirectory,
  runComposeSub,
  UNINSTALL_COMPOSE_HINT,
  UNINSTALL_DAEMON_HINT,
  UNINSTALL_WORKSPACE_HINT,
  uninstallComposeMissingHint,
  uninstallEnvMissingHint,
  uninstallIncompleteDirHint,
  uninstallNotADirHint,
  uninstallUnsafePathHint,
  WAIT_FAILURE_HINT,
  WAIT_TIMEOUT_SECONDS,
  waitForStack,
} from "./prod/lifecycle/steps.ts";
export type {
  LogsColorDecision,
  LogsColorOptions,
  PreparedEnvironment,
  PrepareFailure,
  PrepareOptions,
  PrepareResult,
  StepSink,
  UninstallDependencies,
  UninstallDependenciesResult,
  WaitForStackResult,
} from "./prod/lifecycle/steps.ts";
// profile（T5）：生产安装目录特征文件的**唯一事实源**，由 getProfile 探测消费，
// 避免出现第三份标记清单（T5 carry-forward）。**T12 的 install 不再用它做
// "保留既有配置 vs 首装 seed"判定**（那由 .env.prod 自身是否存在决定，见
// review Finding 1 与 lifecycle.ts 的 envFileExists）。
export { PRODUCTION_MARKERS } from "./profile.ts";
export type {
  InstallOptions,
  InstallResult,
  InstallStep,
  InstallStepName,
  LifecycleBaseResult,
  LifecycleOptions,
  LogsCommandOptions,
  LogsResult,
  StatusResult,
  UninstallOptions,
  UninstallResult,
} from "./prod/lifecycle.ts";
// lifecycle/path（T13 拆分，T15 补反向逻辑）：production.sh 的 register_command /
// unregister_command 迁移 + PATH 字面量。正反两向共享「软链指向何处」判定。
export {
  PATH_LINE,
  registerCommand,
  symlinkPointsToInstall,
  unregisterCommand,
} from "./prod/lifecycle/path.ts";
export type { PathRegistration } from "./prod/lifecycle/path.ts";
