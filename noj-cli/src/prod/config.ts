/**
 * 生产配置校验与交互向导。
 *
 * 门面：再导出 `./config/` 下的校验（必填项、取值约束、站点地址、judge socket、
 * 端口、文件权限）、交互向导（只产出键值，落盘由调用方决定是否传 `envFile`）、
 * 面板检测、镜像验签、部署元数据与备份口令管理。
 *
 * 三条约束（不得绕过）：
 * 1. `validateEnv` **不承载** `JUDGE_ENABLED` 枚举错误，凡走校验的入口都
 *    **先**调 `judgeEnabledError`，非 null 即报错返回，**再**进 `validateEnv`；
 *    且未设置/空串视为**启用**。
 * 2. `writeEnvFileAtomic` 不会 `mkdir` 父目录，调用方保证目录存在。
 * 3. 所有外部命令（docker / cosign / lsof）经注入的 {@link CommandRunner}，
 *    测试永不真的执行；依赖的二进制存在性同样以注入断言代替 `command -v`。
 */

// 本文件为门面（barrel）：实现按职责拆到 `./config/` 子目录，对外导出集合与
// 签名保持不变。

export {
  generateSecret,
  isIpv4Address,
  isSiteAddress,
} from "./config/checks.ts";
export {
  checkJudgeSocket,
  checkPortValue,
  checkRequiredValues,
  DEFAULT_PANEL_COMMAND,
  DEFAULT_PANEL_ROOT,
  detectPanel,
  PANEL_GUIDANCE_OK_LINE,
  panelGuidance,
  showPanelGuidance,
} from "./config/checks.ts";
export {
  runConfigWizard,
  toEntries,
  wizardNeedsInteractiveInput,
} from "./config/wizard.ts";
export {
  backupPassphrasePath,
  DEFAULT_BACKUP_PASSPHRASE_FILE,
  ensureBackupPassphrase,
  PASSPHRASE_ALLOWED_MODES,
  passphraseFileMode,
} from "./config/passphrase.ts";
export {
  DEFAULT_COSIGN_IDENTITY_REGEX,
  DEFAULT_COSIGN_OIDC_ISSUER,
  DEFAULT_IMAGE_REGISTRY,
  DEPLOYMENT_MANIFEST_FILE,
  JUDGE_IMAGES,
  PROD_IMAGES,
  recordDeploymentMetadata,
  verifyImageSignatures,
} from "./config/images.ts";

export type { EnvValues } from "./config/checks.ts";
export type {
  JudgeSocketOptions,
  JudgeSocketResult,
  PanelMode,
  PanelName,
  PanelPaths,
  PanelProbe,
  PortCheckOptions,
  PortCheckResult,
  RequiredValuesReport,
} from "./config/checks.ts";
export type {
  EnsurePassphraseOptions,
  EnsurePassphraseResult,
  PassphrasePathOptions,
} from "./config/passphrase.ts";
export type {
  RecordMetadataOptions,
  RecordMetadataResult,
  VerifiedDigest,
  VerifyImageOptions,
  VerifyImageResult,
} from "./config/images.ts";
export type { WizardOptions, WizardResult } from "./config/wizard.ts";
