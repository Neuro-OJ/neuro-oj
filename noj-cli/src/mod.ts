/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.9.5";

// 状态机与工具（P0）

// TUI（P1）
export type { PromptIO } from "./tui/io.ts";
export { realIO } from "./tui/io.ts";
export { confirm, input, secretInput, select } from "./tui/widgets.ts";

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
  isStableReleaseTag,
  type ReleaseSummary,
  resolveLatestVersion,
  selectLatestAssetReadyRelease,
} from "./runtime/download.ts";
export { fileExists } from "./util/fs.ts";

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
// backup（T17）：`.nojbackup` 单文件容器 + prod-raw payload driver。
// 容器形态**唯一**（payload_layout 恒为 "prod-raw"，无历史兼容）；二进制经
// **文件重定向**采集（spawn 的 stdoutFile），不走 stdout 字符串——见 driver.ts 模块头。
export {
  allocateContainerPath,
  BACKUP_SUFFIX,
  CONTAINER_FILES,
  ContainerError,
  containerFileName,
  createContainer,
  type CreateContainerOptions,
  type CreateContainerResult,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_ZSTD_LEVEL,
  fileSha256HexStreaming,
  listFiles,
  MANIFEST_DEFAULTS,
  parseChecksums,
  PAYLOAD_LAYOUT,
  renderChecksums,
  SCHEMA_VERSION,
  SUCCESS_MARKER,
  tempContainerPath,
  utcTimestamp,
} from "./prod/backup/container.ts";
export type {
  BackupManifest,
  ChecksumEntry,
  ContainerPayloadOps,
  ContainerStage,
} from "./prod/backup/container.ts";
export { Sha256, sha256BytesHex } from "./prod/backup/sha256.ts";
export {
  CaptureError,
  createProdPayloadOps,
  MINIO_CLIENT_IMAGE,
  postgresEnvOf,
  prodComposeArgs,
  realRawDriver,
} from "./prod/backup/driver.ts";
export type {
  ProdComposeContext,
  ProdPayloadOps,
  ProdPayloadOptions,
  RawDriver,
  RawIO,
} from "./prod/backup/driver.ts";
// judge（T21）：独立 Judge Worker 部署的**原生**迁移。两条不可协商的安全约束：
// ① 禁止应用宿主机的共享 Docker socket（/var/run、/run，含 realpath 归一后的等价形式）
//    —— 挂进 Judge 容器等于把评测代码提升到能操作宿主所有容器；
// ② 不碰宿主 Docker daemon（不装/不换/不配置），宝塔类面板只探测不调 API。
export {
  assertDedicatedSocket,
  assertIsolatedDockerRequired,
  assertJudgeConfigValues,
  assertJudgeDockerHost,
  assertJudgeEnvFileMode,
  assertJudgeEnvViaSchema,
  assertJudgeVersion,
  assertRedisContainerName,
  assertRedisPort,
  checkJudgeHost,
  DEFAULT_JUDGE_DIR,
  DEFAULT_JUDGE_REDIS_IMAGE,
  DEFAULT_REDIS_CONTAINER,
  DEFAULT_REDIS_PORT,
  envValue,
  findForbiddenHostCalls,
  FORBIDDEN_HOST_COMMANDS,
  FORBIDDEN_SOCKET_PATHS,
  generateRedisPassword,
  JUDGE_COMPOSE_FILE,
  JUDGE_COMPOSE_MODE,
  JUDGE_DEFAULT_VALUES,
  JUDGE_ENV_ALLOWED_MODES,
  JUDGE_ENV_FILE,
  JUDGE_ENV_MODE,
  JUDGE_PROJECT_NAME,
  JUDGE_REDIS_VOLUME,
  JUDGE_REQUIRED_KEYS,
  JUDGE_SOCKET_CONTAINER_PATH,
  judgePaths,
  readJudgeEnv,
  REDIS_COMPONENT_LABEL,
  REDIS_MANAGED_BY_LABEL,
  writeJudgeEnv,
} from "./prod/judge/config.ts";
export type {
  HostProbe,
  HostProbeResult,
  JudgePaths,
  WriteJudgeEnvOptions,
  WriteJudgeEnvResult,
} from "./prod/judge/config.ts";
export {
  assertAbsolute,
  checkJudgeImageArchitecture,
  checkJudgeRedis,
  checkStandaloneJudgeSocket,
  COMPOSE_ENV_DEFAULTS,
  DEFAULT_JUDGE_IMAGE_REGISTRY,
  dockerArchOf,
  judgeComposeArgs,
  redactUrl,
  redisHostOf,
  renderJudgeCompose,
} from "./prod/judge/compose.ts";
export type {
  ImageArchCheckResult,
  JudgeRedisCheckOptions,
  JudgeRedisCheckResult,
  JudgeSocketCheckOptions,
  JudgeSocketCheckResult,
} from "./prod/judge/compose.ts";
export {
  judgeCheck,
  judgeInstall,
  judgeLogs,
  judgeStart,
  judgeStatus,
  judgeStop,
  judgeUpgrade,
  renderStatusSummary,
} from "./prod/judge/actions.ts";
export type {
  JudgeActionOptions,
  JudgeActionResult,
  JudgeCheckOptions,
  JudgeInstallOptions,
  JudgeLogsOptions,
  JudgeSocketProbes,
  JudgeStatusResult,
} from "./prod/judge/actions.ts";
// schedule（T20）：crontab 标记区块的原生迁移。核心承诺是**只动自己标记的行**：
// 区块外的字节（含顺序与末尾换行）逐字节保留；危险 cron 表达式=注入防线，写入前拒绝。
export {
  assertSchedule,
  BACKUP_DIR_MODE,
  CRON_LOG_MODE,
  CRON_LOG_NAME,
  DEFAULT_SCHEDULE,
  extractManagedBlock,
  installSchedule,
  MARKER_BEGIN,
  MARKER_END,
  quoteForCron,
  readCrontab,
  removeManagedBlock,
  removeSchedule,
  renderScheduleEntry,
  statusSchedule,
  upsertManagedBlock,
  writeCrontab,
} from "./prod/schedule.ts";
export type {
  InstallScheduleOptions,
  ScheduleEntryOptions,
  ScheduleResult,
} from "./prod/schedule.ts";
// drill（T19）：隔离恢复演练的**原生**移植（零 bash / 脚本调用）。
// 隔离性三保证：独立项目名（拒绝含 prod）、独立子网、**不映射宿主机端口**；
// 业务验收由 CLI 直接发 HTTP（经容器 IP），不再依赖额外的 deno 容器镜像。
export {
  allocateDrillDir,
  assertDrillProjectName,
  assertSubnetCidr,
  checkDrillPreflight,
  checkPassphraseFile,
  DEFAULT_DRILL_PROJECT_NAME,
  DEFAULT_DRILL_SUBNET,
  DEFAULT_EVALUATOR_IMAGE,
  DEFAULT_RPO_MAX_HOURS,
  DEFAULT_RTO_MAX_MINUTES,
  DEFAULT_SOLUTION_IMAGE,
  DEFAULT_WAIT_TIMEOUT,
  DRILL_ADMIN_EMAIL_DOMAIN,
  DRILL_ADMIN_PASSWORD,
  DRILL_ADMIN_USER,
  DRILL_BCRYPT_HASH,
  DRILL_MIN_FREE_BYTES,
  DRILL_NETWORK_NAME,
  drillCleanupArgs,
  drillComposeArgs,
  drillDirName,
  DrillPreflightError,
  probeDocker,
  probeFreeBytes,
  readEnvValues,
  renderDrillOverride,
  resolveReportPath,
  valueOr,
} from "./prod/drill/plan.ts";
export {
  buildDrillBundle,
  runBusinessVerification,
} from "./prod/drill/verify.ts";
export type {
  VerifyOptions,
  VerifyResult,
  VerifyStep,
} from "./prod/drill/verify.ts";
export {
  CREDENTIAL_NOTE,
  DRILL_METRICS_FILE,
  DRILL_TYPE,
  formatHours,
  hoursSinceSnapshot,
  METRIC_LAST_SUCCESS,
  metricsDirOf,
  renderChecks,
  renderDrillMetrics,
  renderFailureReport,
  renderReport,
  REPORT_FILE_NAME,
  snapshotCreatedAt,
} from "./prod/drill/report.ts";
export type {
  ChecksInput,
  FailureReportInput,
  ReportInput,
} from "./prod/drill/report.ts";
export {
  makeIdempotentGlobals,
  runDrill,
  tailLines,
} from "./prod/drill/drill.ts";
export type {
  DrillRunOptions,
  DrillRunResult,
  JudgeImageContext,
} from "./prod/drill/drill.ts";
// backup 命令面（T18）：verify 三档 / list / prune（默认 dry-run）/ restore --dry-run。
// 三条硬约束：三档累加；prune 默认零删除；四个命令都不得创建备份（实测过的误路由）。
export {
  assertContainerPath,
  backupCount,
  type BackupListResult,
  type BackupPruneResult,
  type BackupVerifyResult,
  listBackupCommand,
  prodBackupDir,
  pruneCommand,
  restorePlan,
  type RestorePlanOptions,
  type RestoreStep,
  verifyCommand,
} from "./prod/backup/commands.ts";
export {
  CHECKSUM_SUFFIX,
  readManifest,
  unpackContainer,
  verifyContainer,
} from "./prod/backup/container.ts";
export type {
  UnpackContainerOptions,
  UnpackContainerResult,
  VerifyContainerOptions,
  VerifyContainerResult,
  VerifyIssue,
} from "./prod/backup/container.ts";
// release（T16）：生产升级的版本解析与版本配置落盘（production.sh 的
// validate_release_tag / latest_release_version / configured_version /
// write_config_version）。过滤规则与 runtime/download.ts **同源**
// （selectLatestAssetReadyRelease），只是资产集合更宽（含 compose/example）。
export {
  commitConfigVersion,
  configuredVersion,
  DEFAULT_UPDATE_REPOSITORY,
  envMissingHint,
  httpsOnlyHint,
  normalizedVersion,
  releaseListHint,
  releasesApiUrl,
  releaseTagHint,
  resolveLatestReleaseTag,
  SINGLE_RELEASE_INVALID_HINT,
  stageConfigVersion,
  UPDATE_API_URL_HINT,
  UPDATE_RELEASE_ASSETS,
  validateReleaseTag,
  versionConfigText,
  versionMissingHint,
  writeConfigVersion,
} from "./prod/release.ts";
// compose（T10）：prod 侧服务集与 compose 调用封装。生产编排只认仓库内固定的
// docker-compose.prod.yml（T9 下载并校验），**不引入运行时渲染**（spec §3.4）。
export {
  composeArgs,
  composeConfig,
  composeDown,
  composeLogs,
  composePs,
  composePull,
  composeUp,
  PROD_COMPOSE_FILE,
  PROD_ENV_FILE,
  PROD_SERVICES,
} from "./prod/compose.ts";
export type {
  ComposeArgsOptions,
  ComposeConfigOptions,
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
  update,
  // T16：升级（固定版本 / --latest 两种模式 + 备份 → pull → wait → metadata 序列）。
  // `upgrade` 是 `update` 的别名（bash 两个词进同一函数），行为逐字一致。
  UPDATE_BACKUP_UNAVAILABLE_HINT,
  UPDATE_UP_TO_DATE_HINT,
  updateSuccessHint,
  upgrade,
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
  ensureCommandPassphrase,
  mergeColorSource,
  NGINX_REFRESH_FAILURE_HINT,
  PASSPHRASE_CARRY_HINT,
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
  PassphraseStepOptions,
  PassphraseStepResult,
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
  UpdateBackupContext,
  UpdateBackupResult,
  UpdateOptions,
  UpdateResult,
  UpdateSyncContext,
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
