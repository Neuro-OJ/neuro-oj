/**
 * 生产配置校验与交互向导（T11）。
 *
 * 逐项迁移 `scripts/deploy/deploy.sh` 的配置能力，行为对照（R3）：
 * - `is_ipv4_address` :344、`is_site_address` :354
 * - `generate_secret` :220、`current_config_value` :275
 * - `configuration_needs_interactive_input` :390
 * - `configure_env_interactive` :429-595（本模块只做"产出键值"，落盘由调用方
 *   决定是否传 `envFile`；生命周期动作属 T12–T16，不在本模块）
 * - `check_required_values` :684-766（含 EMAIL_PROVIDER 分支 :718-737、取值约束
 *   :739-764 与 `is_site_address` :713）、`check_judge_socket` :768
 * - `check_file_permissions` :658-665（经 {@link checkEnvFileMode}）
 * - `check_port_value` :780、`detect_panel` :791、`show_panel_guidance` :804
 * - `verify_image_signatures` :837-874、`record_deployment_metadata` :875-891
 * - `passphrase_file_mode` :916、`ensure_backup_passphrase` :920-953
 *
 * 三个 carry-forward（不得绕过）：
 * 1. T2：`validateEnv` **不承载** `JUDGE_ENABLED` 枚举错误，凡走校验的入口都
 *    **先**调 `judgeEnabledError`，非 null 即报错返回，**再**进 `validateEnv`；
 *    且未设置/空串视为**启用**（deploy.sh:679）。
 * 2. T3：`writeEnvFileAtomic` 不会 `mkdir` 父目录，调用方保证目录存在。
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
