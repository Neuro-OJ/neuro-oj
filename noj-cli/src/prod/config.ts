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

import { dirname, join } from "@std/path";
import {
  ALIYUN_EMAIL_KEYS,
  EMAIL_PROVIDERS,
  emailBranchKeys,
  ENV_VALUE_RULES,
  isPlaceholder,
  JUDGE_KEYS,
  judgeEnabledError,
  TENCENT_EMAIL_KEYS,
  validateEnv,
} from "../core/config-schema.ts";
import { writeEnvFileAtomic } from "../core/env-file.ts";
import { randomKey } from "../util/random.ts";
import { nonInteractiveAdvice } from "./advice.ts";
import { createTheme, type Theme } from "../output/theme.ts";
import type { CommandRunner } from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import { confirm, input, secretInput } from "../tui/widgets.ts";

/** 环境值表：.env.prod 的键值；`undefined` 表示键未设置。 */
export type EnvValues = Record<string, string | undefined>;

// ---------------- 内部复用原语 ----------------

/** 只保留已定义的值，供 T2 的 `validateEnv` 消费。 */
function definedOnly(env: EnvValues): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/**
 * 判定 judge 是否启用。
 *
 * **不复制 T2 的真值表**：以 `validateEnv` 在"仅含 JUDGE_ENABLED 的探针输入"
 * 下是否要求 JUDGE_DOCKER_SOCKET 为准，T2 增删真值集合时本函数自动跟随。
 * 枚举外的非法值须先经 {@link judgeEnabledError} 拒绝；此处沿用 T2 的
 * fail-safe（非法值按启用处理）。
 */
function judgeEnabledFrom(env: EnvValues): boolean {
  const probe = validateEnv({ JUDGE_ENABLED: env["JUDGE_ENABLED"] ?? "" });
  return probe.missing.includes(JUDGE_KEYS[0] ?? "JUDGE_DOCKER_SOCKET");
}

/** `-e` 语义的存在性探测（socket / 设备也算存在）。 */
async function pathExists(path: string): Promise<boolean> {
  if (path === "") return false;
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** bash `current_config_value`（:275-285）：占位值归零，DOMAIN 的退出词归零。 */
const EXIT_WORDS: ReadonlySet<string> = new Set([
  "exit",
  "EXIT",
  "quit",
  "QUIT",
  "cancel",
  "CANCEL",
  "q",
  "Q",
  "取消",
]);

/** 取"当前可用值"：占位值/未配置一律返回空串。 */
function currentConfigValue(env: EnvValues, key: string): string {
  const raw = env[key] ?? "";
  if (isPlaceholder(raw)) return "";
  if (key === "DOMAIN" && EXIT_WORDS.has(raw)) return "";
  return raw;
}

/** 生成 32 字节随机 hex（64 位），即 bash `openssl rand -hex 32`。 */
export function generateSecret(): string {
  return randomKey(32);
}

// ---------------- 站点地址 ----------------

/** bash `is_ipv4_address`（:344-352）：四段 1-3 位数字且每段 ≤ 255。 */
export function isIpv4Address(address: string): boolean {
  const match = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/
    .exec(address);
  if (match === null) return false;
  for (let i = 1; i <= 4; i++) {
    if (Number(match[i]) > 255) return false;
  }
  return true;
}

/**
 * bash `is_site_address`（:354-361）：IPv4 或「字母数字开头结尾、中间允许
 * `.`/\`-\`、且含点」的字符串。
 *
 * 注意这是**逐字移植**：`a..b`（连续点）与 `bad-.com`（段尾连字符）在 bash
 * 正则下都算合法，此处保持一致，不做额外收紧。
 */
export function isSiteAddress(address: string): boolean {
  if (isIpv4Address(address)) return true;
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address) &&
    address.includes(".");
}

// ---------------- 必填校验 ----------------

/** {@link checkRequiredValues} 的报告。 */
export interface RequiredValuesReport {
  /** 是否全部通过（含 judge 枚举、judge 键、站点地址、邮件分支与取值约束）。 */
  ok: boolean;
  /** `JUDGE_ENABLED` 枚举错误；非 null 时其余字段为空（先于 validateEnv）。 */
  judgeError: string | null;
  /** judge 是否启用（未设置/空串视为启用，见 T2 carry-forward）。 */
  judgeEnabled: boolean;
  /**
   * 判定失败的键：未设置、空值、占位值，或 judge 启用时非数字的 GID
   * （bash :747 把 GID 非数字也写进 missing 计数）。顺序与 T2 的
   * `validateEnv` 一致；judge 启用时追加 JUDGE_KEYS。
   */
  missing: string[];
  /** 命中占位值黑名单的键。 */
  placeholder: string[];
  /** 面向用户的逐行错误（含 "  - " 前缀，与 bash printf 一致）。 */
  errors: string[];
  /** DOMAIN 不是域名/IP 时的错误；合法或缺失时为 null。 */
  siteAddressError: string | null;
}

/**
 * 迁移 `check_required_values`（:684-766）。
 *
 * 判定顺序：
 * 1. **先** {@link judgeEnabledError}（T2 carry-forward）；非 null 立即返回；
 *    bash 中该错误由 `judge_enabled` 的 `*) fail` 产出，此处等价地作为硬错误；
 * 2. {@link validateEnv} 得到 missing / placeholder（judge 启用时自动含 judge 键）；
 * 3. DOMAIN 站点地址检查（:713）；
 * 4. judge 启用且 GID 非数字（:747-750，错误同时计入 missing）；
 * 5. EMAIL_PROVIDER 枚举 + 分支条件键（:718-737）；
 * 6. 取值约束 STORAGE_PROVIDER / JWT_SECRET / APP_URL / NOJ_VERSION
 *    （:739-764，规则表在 T2 的 `ENV_VALUE_RULES`）。
 *
 * 与 bash 的差异（有意）：
 * - bash 在缺失/占位阶段就 `fail`（硬错误退出），后半段根本不会被执行到；
 *   本函数不提前退出，把全部失败并入 `errors` 后由调用方一次性处理，因此
 *   `errors` 的**顺序**是 TS 自定的稳定顺序，而非 bash 的打印顺序；
 * - 取值约束（步骤 6）仅在键**已配置且非占位**时判定，避免与「未配置」重复报错。
 */
export function checkRequiredValues(env: EnvValues): RequiredValuesReport {
  const judgeError = judgeEnabledError(env["JUDGE_ENABLED"]);
  if (judgeError !== null) {
    return {
      ok: false,
      judgeError,
      judgeEnabled: false,
      missing: [],
      placeholder: [],
      errors: [judgeError],
      siteAddressError: null,
    };
  }

  const judgeEnabled = judgeEnabledFrom(env);
  const { missing: missingBase, placeholder } = validateEnv(definedOnly(env));

  const missing = [...missingBase];
  const errors = [...missingBase, ...placeholder].map((key) =>
    `  - ${key} 未配置或仍是占位值`
  );

  const domain = env["DOMAIN"] ?? "";
  const siteAddressError = isSiteAddress(domain)
    ? null
    : "网站地址必须是域名或服务器 IP";
  if (siteAddressError !== null) {
    errors.push("  - " + siteAddressError);
  }

  // judge 分支（bash :747-750）：GID 必须是纯数字；该错误同样计入 missing。
  if (judgeEnabled) {
    const gid = env["JUDGE_DOCKER_SOCKET_GID"];
    if (gid !== undefined && gid !== "" && !/^[0-9]+$/.test(gid)) {
      if (!missing.includes("JUDGE_DOCKER_SOCKET_GID")) {
        missing.push("JUDGE_DOCKER_SOCKET_GID");
      }
      errors.push("  - JUDGE_DOCKER_SOCKET_GID 必须是数字");
    }
  }

  // EMAIL_PROVIDER 枚举 + 分支条件键（bash :718-737）。
  // 占位/空值已由 validateEnv 记入 missing（bash 在缺失阶段即 fail，枚举行不可达），
  // 故仅在非占位时做枚举校验，避免同一键同时报"未配置"与"枚举非法"。
  const provider = env["EMAIL_PROVIDER"] ?? "";
  if (!isPlaceholder(provider)) {
    if (!EMAIL_PROVIDERS.includes(provider)) {
      errors.push("  - EMAIL_PROVIDER 必须是 aliyun、tencent 或 disabled");
    } else {
      for (const key of emailBranchKeys(provider)) {
        if (isPlaceholder(env[key])) {
          if (!missing.includes(key)) missing.push(key);
          errors.push(`  - ${key} 未配置或仍是占位值`);
        }
      }
    }
  }

  // 后半段取值约束（bash :739-764）：仅对**已配置且非占位**的键判定，
  // 否则「未配置」已由上面的 missing 表达，不重复报错。GID 不在本表内，
  // 由上面的 judge 分支单独处理（其错误还需计入 missing）。
  for (const rule of ENV_VALUE_RULES) {
    const value = env[rule.key];
    if (value === undefined || isPlaceholder(value)) continue;
    const error = rule.check(definedOnly(env), value);
    if (error !== null) errors.push("  - " + error);
  }

  return {
    // errors 已汇总 missing / placeholder / 站点地址 / judge GID / 枚举 / 取值约束，
    // 故它是"是否通过"的唯一事实源。
    ok: errors.length === 0,
    judgeError: null,
    judgeEnabled,
    missing,
    placeholder,
    errors,
    siteAddressError,
  };
}

// ---------------- judge socket / 端口 ----------------

/** {@link checkJudgeSocket} 结果。 */
export interface JudgeSocketResult {
  ok: boolean;
  error: string | null;
}

/** {@link checkJudgeSocket} 的注入点。 */
export interface JudgeSocketOptions {
  /** socket 存在性判定；缺省用 `Deno.stat`（`-e` 语义）。 */
  socketExists?: (path: string) => Promise<boolean>;
}

/**
 * 迁移 `check_judge_socket`（:768-778）并补上 GID 数字校验（:747 的同义检查）。
 *
 * 顺序与 bash 一致：先拒绝宿主 Docker socket，再要求 socket 存在；GID 为可选的
 * 附加校验（bash 在 `check_required_values` 内检查，本模块收敛到同一入口）。
 */
export async function checkJudgeSocket(
  env: EnvValues,
  opts: JudgeSocketOptions = {},
): Promise<JudgeSocketResult> {
  const socketPath = env["JUDGE_DOCKER_SOCKET"] ?? "";
  if (
    socketPath === "/var/run/docker.sock" || socketPath === "/run/docker.sock"
  ) {
    return {
      ok: false,
      error: `禁止将应用宿主机 Docker socket 挂载给 judge：${socketPath}`,
    };
  }

  const exists = opts.socketExists ?? pathExists;
  if (!(await exists(socketPath))) {
    return {
      ok: false,
      error: `Judge 隔离 Docker socket 不存在：${socketPath}`,
    };
  }

  const gid = env["JUDGE_DOCKER_SOCKET_GID"];
  if (gid !== undefined && gid !== "" && !/^[0-9]+$/.test(gid)) {
    return { ok: false, error: "JUDGE_DOCKER_SOCKET_GID 必须是数字" };
  }
  return { ok: true, error: null };
}

/** {@link checkPortValue} 结果。 */
export interface PortCheckResult {
  port: number;
  error: string | null;
  warning: string | null;
}

/** {@link checkPortValue} 的注入点。 */
export interface PortCheckOptions {
  /** 注入的 runner；缺省时跳过 lsof 占用探测（`command -v lsof` 的等价开关）。 */
  runner?: CommandRunner;
}

/**
 * 迁移 `check_port_value`（:780-789）：默认 8080，必须是 1-65535 的纯数字。
 *
 * lsof 占用告警只在注入 runner 时执行；bash 的 `command -v lsof` 由调用方通过
 * "是否传 runner"表达（runner 在 lsof 缺失时自会返回非 0）。
 */
export async function checkPortValue(
  env: EnvValues,
  opts: PortCheckOptions = {},
): Promise<PortCheckResult> {
  const raw = env["NGINX_PORT"] ?? "";
  const effective = raw === "" ? "8080" : raw;
  const error = "NGINX_PORT 必须是 1-65535 的端口号";
  if (!/^[0-9]+$/.test(effective)) {
    return { port: 0, error, warning: null };
  }
  const port = Number(effective);
  if (port < 1 || port > 65535) {
    return { port, error, warning: null };
  }

  let warning: string | null = null;
  if (opts.runner !== undefined) {
    const result = await opts.runner.run("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    if (result.code === 0) {
      warning = `NGINX_PORT=${port} 已被其他进程监听；启动时可能发生端口冲突`;
    }
  }
  return { port, error: null, warning };
}

// ---------------- 宝塔面板 ----------------

/** 面板判定结果。 */
export type PanelName = "none" | "baota";

/** `--panel` 取值。 */
export type PanelMode = "auto" | "baota" | "none";

/** 面板探测路径（对应 bash `PANEL_ROOT` / `PANEL_COMMAND`）。 */
export interface PanelPaths {
  panelRoot?: string;
  panelCommand?: string;
}

/** 面板探测的注入点（测试不碰真实文件系统）。 */
export interface PanelProbe {
  dirExists(path: string): Promise<boolean>;
  execExists(path: string): Promise<boolean>;
}

/** bash 默认面板根目录。 */
export const DEFAULT_PANEL_ROOT = "/www/server/panel";
/** bash 默认面板命令。 */
export const DEFAULT_PANEL_COMMAND = "/usr/bin/bt";

/** 真实探测：目录存在 / 可执行文件存在（`-x`）。 */
const realPanelProbe: PanelProbe = {
  async dirExists(path) {
    try {
      return (await Deno.stat(path)).isDirectory;
    } catch {
      return false;
    }
  },
  async execExists(path) {
    try {
      const st = await Deno.stat(path);
      return st.isFile && ((st.mode ?? 0) & 0o111) !== 0;
    } catch {
      return false;
    }
  },
};

/**
 * 迁移 `detect_panel`（:791-802）。
 *
 * `baota` 直接命中且**零探测**；`none` 直接返回；`auto` 才探测目录/命令。
 */
export async function detectPanel(
  mode: PanelMode,
  paths: PanelPaths = {},
  probe: PanelProbe = realPanelProbe,
): Promise<PanelName> {
  if (mode === "baota") return "baota";
  if (mode === "none") return "none";
  const root = paths.panelRoot ?? DEFAULT_PANEL_ROOT;
  const command = paths.panelCommand ?? DEFAULT_PANEL_COMMAND;
  if ((await probe.dirExists(root)) || (await probe.execExists(command))) {
    return "baota";
  }
  return "none";
}

/** 宝塔引导正文（逐字对照 deploy.sh:807-816 的 heredoc）。 */
const BAOTA_GUIDANCE = [
  "已检测到宝塔面板。脚本会直接使用宝塔管理的标准 Docker/Compose，不调用宝塔 API。",
  "",
  "前后端 Compose 自带 Nginx。请在宝塔的网站/反向代理中把域名转发到",
  "127.0.0.1:NGINX_PORT，默认端口为 8080；如果修改了 .env.prod 中的 NGINX_PORT，",
  "请使用修改后的端口。请先确认该端口没有被宝塔已有网站或其他服务占用。",
  "",
  "脚本不会修改已有站点、证书、反向代理、容器或面板配置。如果安装 Judge，仍必须使用",
  "只服务于 Judge 的 rootless Docker socket，不能填写 /run/docker.sock 或 /var/run/docker.sock。",
].join("\n");

/** 宝塔引导文本；非 baota 返回 null（对应 `show_panel_guidance` 的早退）。 */
export function panelGuidance(panel: PanelName | PanelMode): string | null {
  return panel === "baota" ? BAOTA_GUIDANCE : null;
}

/** bash `:817` 的 ok 行（`show_panel_guidance` 的收尾输出）。 */
export const PANEL_GUIDANCE_OK_LINE = "✓ 宝塔兼容提示已启用";

/**
 * 迁移 `show_panel_guidance`（:804-818）：仅 baota 时输出
 * section 标题 + 正文 + {@link PANEL_GUIDANCE_OK_LINE}（bash 无着色时 ok() 的
 * 逐字输出）。
 */
export function showPanelGuidance(
  panel: PanelName | PanelMode,
  io: PromptIO,
): void {
  const text = panelGuidance(panel);
  if (text === null) return;
  io.write("\n== 宝塔兼容模式 ==\n");
  io.write(text + "\n");
  io.write(PANEL_GUIDANCE_OK_LINE + "\n");
}

// ---------------- 镜像验签 ----------------

/** 默认镜像仓库（compose 文件里的 `${NOJ_IMAGE_REGISTRY:-...}`）。 */
export const DEFAULT_IMAGE_REGISTRY = "ghcr.io/neuro-oj";

/** 默认 cosign 证书身份正则（deploy.sh:851）。 */
export const DEFAULT_COSIGN_IDENTITY_REGEX =
  "^https://github.com/Neuro-OJ/neuro-oj/.github/workflows/release.yml@.*$";

/** cosign OIDC issuer（deploy.sh:867）。 */
export const DEFAULT_COSIGN_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

/** 无条件校验的生产镜像（deploy.sh:854）。 */
export const PROD_IMAGES: readonly string[] = [
  "noj-server",
  "noj-ui",
  "noj-llm-gateway",
];

/** judge 启用时追加的镜像（deploy.sh:856）。 */
export const JUDGE_IMAGES: readonly string[] = [
  "noj-judge",
  "noj-evaluator-python",
  "noj-solution-python",
];

/** 已验签的镜像 digest 记录（亦为 `record_deployment_metadata` 的输入）。 */
export interface VerifiedDigest {
  /** 完整镜像引用（含 tag）。 */
  image: string;
  /** 镜像短名（写入部署元数据）。 */
  name: string;
  /** `sha256:<64 hex>`。 */
  digest: string;
}

/** {@link verifyImageSignatures} 的注入点。 */
export interface VerifyImageOptions {
  runner: CommandRunner;
  /** cosign 是否可用（`command -v cosign` 的等价注入）。缺省视为可用。 */
  cosignAvailable?: () => Promise<boolean>;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
  /** cosign 可执行名。 */
  cosignBin?: string;
  /** 告警汇聚点（关闭验签时提示）。 */
  warn?: (message: string) => void;
}

/** {@link verifyImageSignatures} 结果。 */
export interface VerifyImageResult {
  ok: boolean;
  /** `NOJ_ENFORCE_IMAGE_SIGNATURES=false` 时为 true（未执行任何命令）。 */
  skipped: boolean;
  error: string | null;
  /** 已通过验签的镜像（失败时只含失败前已通过的）。 */
  digests: VerifiedDigest[];
}

/** 从 `buildx imagetools inspect` 输出取 digest（对应 awk '/^Digest:/ {print $2}'）。 */
function parseDigest(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const match = /^Digest:\s+(\S+)/.exec(line);
    if (match !== null) {
      return /^sha256:[0-9a-f]{64}$/.test(match[1] ?? "") ? match[1]! : null;
    }
  }
  return null;
}

/**
 * 迁移 `verify_image_signatures`（:837-874）。
 *
 * - `NOJ_ENFORCE_IMAGE_SIGNATURES=false` → 跳过（零调用）；
 * - cosign 不可用 → 报错返回（零调用）；
 * - 逐镜像：`docker buildx imagetools inspect` 取 digest → `cosign verify`
 *   校验身份正则与 OIDC issuer；任一失败即返回其错误。
 *
 * 所有命令都经注入 runner；`command -v cosign` 以注入的 `cosignAvailable` 替代。
 */
export async function verifyImageSignatures(
  env: EnvValues,
  opts: VerifyImageOptions,
): Promise<VerifyImageResult> {
  if ((env["NOJ_ENFORCE_IMAGE_SIGNATURES"] ?? "") === "false") {
    opts.warn?.("NOJ_ENFORCE_IMAGE_SIGNATURES=false，已关闭镜像签名校验");
    return { ok: true, skipped: true, error: null, digests: [] };
  }

  const dockerBin = opts.dockerBin ?? "docker";
  const cosignBin = opts.cosignBin ?? "cosign";
  const cosignAvailable = opts.cosignAvailable ??
    (() => Promise.resolve(true));
  if (!(await cosignAvailable())) {
    return {
      ok: false,
      skipped: false,
      error:
        "已开启镜像签名校验，但找不到 Cosign；请先安装 Cosign，或将 NOJ_ENFORCE_IMAGE_SIGNATURES 设置为 false",
      digests: [],
    };
  }

  const version = env["NOJ_VERSION"] ?? "";
  const registry = env["NOJ_IMAGE_REGISTRY"] || DEFAULT_IMAGE_REGISTRY;
  const identity = env["NOJ_COSIGN_CERT_IDENTITY_REGEX"] ||
    DEFAULT_COSIGN_IDENTITY_REGEX;
  const images = judgeEnabledFrom(env)
    ? [...PROD_IMAGES, ...JUDGE_IMAGES]
    : [...PROD_IMAGES];

  const digests: VerifiedDigest[] = [];
  for (const name of images) {
    const image = `${registry}/${name}:${version}`;
    const inspect = await opts.runner.run(dockerBin, [
      "buildx",
      "imagetools",
      "inspect",
      image,
    ]);
    const digest = parseDigest(inspect.stdout);
    if (digest === null) {
      return {
        ok: false,
        skipped: false,
        error: `无法解析生产镜像 digest：${image}`,
        digests,
      };
    }

    const ref = `${image}@${digest}`;
    const verify = await opts.runner.run(cosignBin, [
      "verify",
      "--certificate-identity-regexp",
      identity,
      "--certificate-oidc-issuer",
      DEFAULT_COSIGN_OIDC_ISSUER,
      ref,
    ]);
    if (verify.code !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `生产镜像 Cosign 签名校验失败：${ref}`,
        digests,
      };
    }
    digests.push({ image, name, digest });
  }

  return { ok: true, skipped: false, error: null, digests };
}

// ---------------- 部署元数据 ----------------

/** 部署元数据文件名（deploy.sh:881）。 */
export const DEPLOYMENT_MANIFEST_FILE = "current-deployment.txt";

/** {@link recordDeploymentMetadata} 的输入。 */
export interface RecordMetadataOptions {
  version: string;
  at: Date;
  verified: VerifiedDigest[];
  backupDir: string;
  fileName?: string;
}

/** {@link recordDeploymentMetadata} 结果。 */
export interface RecordMetadataResult {
  written: boolean;
  path: string | null;
}

/**
 * 迁移 `record_deployment_metadata`（:875-891）。
 *
 * 无验签结果时不产生任何副作用（bash 的 `return 0`）；否则在 `backupDir` 下
 * 原子写出 `current-deployment.txt`（权限 600），内容为
 * `version=` / `recorded_at=` / 排序后的 `<name> <digest>` 行。
 */
export async function recordDeploymentMetadata(
  opts: RecordMetadataOptions,
): Promise<RecordMetadataResult> {
  if (opts.verified.length === 0) return { written: false, path: null };

  await Deno.mkdir(opts.backupDir, { recursive: true });
  const manifest = join(
    opts.backupDir,
    opts.fileName ?? DEPLOYMENT_MANIFEST_FILE,
  );
  const recordedAt = opts.at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const digestLines = opts.verified
    .map((entry) => `${entry.name} ${entry.digest}`)
    .sort();
  const text = `version=${opts.version}\nrecorded_at=${recordedAt}\n${
    digestLines.join("\n")
  }\n`;

  const tmp = join(
    opts.backupDir,
    `.current-deployment.${Deno.pid}.${crypto.randomUUID()}`,
  );
  try {
    const file = await Deno.open(tmp, {
      create: true,
      write: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      await file.write(new TextEncoder().encode(text));
    } finally {
      file.close();
    }
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, manifest);
  } catch (err) {
    try {
      await Deno.remove(tmp);
    } catch {
      // 清理失败不覆盖原始错误
    }
    throw err;
  }
  return { written: true, path: manifest };
}

// ---------------- 备份口令 ----------------

/** bash `DEFAULT_BACKUP_PASSPHRASE_FILE`（:28）。 */
export const DEFAULT_BACKUP_PASSPHRASE_FILE = "/etc/noj/backup-passphrase";

/** 口令文件允许的权限（deploy.sh:930）。 */
export const PASSPHRASE_ALLOWED_MODES: readonly string[] = ["600", "400"];

/**
 * 迁移 `passphrase_file_mode`（:916-918）：返回八进制权限串（如 "600"/"640"）。
 *
 * bash 用 `stat -c %a`；文件缺失时 bash 返回空串，本实现抛 `Deno.errors.NotFound`
 * （调用方先做存在性判定，见 {@link ensureBackupPassphrase}）。
 */
export async function passphraseFileMode(path: string): Promise<string> {
  const st = await Deno.stat(path);
  return ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0");
}

/** {@link backupPassphrasePath} 的候选来源（优先级从高到低）。 */
export interface PassphrasePathOptions {
  /** `--passphrase-file`。 */
  flag?: string;
  /** 环境变量 `NOJ_BACKUP_PASSPHRASE_FILE`（进程环境）。 */
  explicit?: string;
  /** .env.prod 中的 `NOJ_BACKUP_PASSPHRASE_FILE`。 */
  configured?: string;
}

/**
 * 迁移 `ensure_backup_passphrase` 的目标选择（deploy.sh:924）：
 * `flag` > `explicit` > `configured` > {@link DEFAULT_BACKUP_PASSPHRASE_FILE}。
 */
export function backupPassphrasePath(opts: PassphrasePathOptions): string {
  return opts.flag || opts.explicit || opts.configured ||
    DEFAULT_BACKUP_PASSPHRASE_FILE;
}

/** {@link ensureBackupPassphrase} 的注入点。 */
export interface EnsurePassphraseOptions {
  /** 覆盖目标路径（测试用；生产由 {@link backupPassphrasePath} 决定）。 */
  targetFile?: string;
  /**
   * 口令来源是否来自**进程环境** `NOJ_BACKUP_PASSPHRASE_FILE`（deploy.sh:27 把
   * 它读进 `BACKUP_PASSPHRASE_FILE`）。
   *
   * bash `ensure_backup_passphrase` 的回填门（:948）**只读进程环境**：
   * `[[ -z "$configured_file" && -z "${NOJ_BACKUP_PASSPHRASE_FILE:-}" ]]`，其中
   * `configured_file` 是 .env.prod 里的值（:923），第二个是进程环境（:27）。
   * **`--passphrase-file` 旗标不参与该门**：bash :924 只用它选目标路径，:948
   * 不再引用它，故旗标给出的路径仍会被回填进 .env.prod（R3 逐字对齐）。
   *
   * 缺省 false = 进程环境未给出该变量 → 允许回填。
   */
  configuredFromEnv?: boolean;
}

/** {@link ensureBackupPassphrase} 结果。 */
export interface EnsurePassphraseResult {
  path: string;
  created: boolean;
  /** 本次新生成的口令明文；复用已有文件时为 null。 */
  passphrase: string | null;
  /** 需要回填到 .env.prod 的键；无需回填时为 null。 */
  envUpdate: Record<string, string> | null;
  error: string | null;
}

/**
 * 迁移 `ensure_backup_passphrase`（:920-953）。
 *
 * - 目标存在：必须是普通文件且权限为 600/400，否则拒绝并给可操作提示；
 * - 目标缺失：`mkdir -p -m 700` 父目录 → 生成 32 字节 hex → 临时文件 600 →
 *   原子 rename → 最终 600；仅当"配置里没有该键 **且** 进程环境未给出
 *   `NOJ_BACKUP_PASSPHRASE_FILE`"时才回填（对照 :948 的 `-z "$configured_file"
 *   && -z "${NOJ_BACKUP_PASSPHRASE_FILE:-}"`）。**`--passphrase-file` 旗标不抑制
 *   回填**：bash :948 只读进程环境，旗标仅在 :924 参与选目标路径。
 *
 * 口令生成不依赖 openssl（复用 init/secrets.ts 的 `randomKey`），因此不会因缺
 * openssl 失败；这是与 bash 的唯一有意差异，见 task-11 报告。
 */
export async function ensureBackupPassphrase(
  env: EnvValues,
  opts: EnsurePassphraseOptions = {},
): Promise<EnsurePassphraseResult> {
  const configured = env["NOJ_BACKUP_PASSPHRASE_FILE"] ?? "";
  const target = opts.targetFile ?? backupPassphrasePath({ configured });

  let stat: Deno.FileInfo | null = null;
  try {
    stat = await Deno.stat(target);
  } catch {
    stat = null;
  }

  if (stat !== null) {
    if (!stat.isFile) {
      return {
        path: target,
        created: false,
        passphrase: null,
        envUpdate: null,
        error: `GPG 备份口令路径不是普通文件：${target}`,
      };
    }
    const mode = await passphraseFileMode(target);
    if (!PASSPHRASE_ALLOWED_MODES.includes(mode)) {
      return {
        path: target,
        created: false,
        passphrase: null,
        envUpdate: null,
        error: `GPG 备份口令文件权限必须为 600 或 400：${target}`,
      };
    }
    return {
      path: target,
      created: false,
      passphrase: null,
      envUpdate: null,
      error: null,
    };
  }

  const passphrase = generateSecret();
  const parent = dirname(target);
  const tmp = `${target}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    if (parent !== "" && parent !== ".") {
      await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
    }
    const file = await Deno.open(tmp, {
      create: true,
      write: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      await file.write(new TextEncoder().encode(passphrase));
    } finally {
      file.close();
    }
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, target);
    await Deno.chmod(target, 0o600);
  } catch {
    try {
      await Deno.remove(tmp);
    } catch {
      // 清理失败不覆盖原始错误
    }
    return {
      path: target,
      created: false,
      passphrase: null,
      envUpdate: null,
      error:
        `无法创建 GPG 备份口令文件：${target}；请使用 --passphrase-file 指定可写路径`,
    };
  }

  return {
    path: target,
    created: true,
    passphrase,
    // 回填条件与 bash :948 一致：.env.prod 里没有该键，且进程环境未给出该变量。
    // `--passphrase-file` 旗标不抑制回填（bash :948 只读进程环境）。
    envUpdate: configured === "" && !opts.configuredFromEnv
      ? { NOJ_BACKUP_PASSPHRASE_FILE: target }
      : null,
    error: null,
  };
}

// ---------------- 向导 ----------------

/** 向导的核心键（对应 `configuration_needs_interactive_input`:392）。 */
const WIZARD_CORE_KEYS: readonly string[] = [
  "NOJ_VERSION",
  "DOMAIN",
  "APP_URL",
  "EMAIL_PROVIDER",
  "JUDGE_ENABLED",
];

/** 跳过邮件时清空的键（:548-549）。 */
const ALL_EMAIL_KEYS: readonly string[] = [
  ...ALIYUN_EMAIL_KEYS,
  ...TENCENT_EMAIL_KEYS,
];

/** 迁移 `configuration_needs_interactive_input`（:390-417）。 */
function wizardMissingKeys(env: EnvValues): string[] {
  const missing: string[] = [];
  for (const key of WIZARD_CORE_KEYS) {
    if (isPlaceholder(currentConfigValue(env, key))) missing.push(key);
  }
  for (const key of emailBranchKeys(env["EMAIL_PROVIDER"])) {
    if (isPlaceholder(currentConfigValue(env, key))) missing.push(key);
  }
  if (judgeEnabledFrom(env)) {
    for (const key of JUDGE_KEYS) {
      if (isPlaceholder(currentConfigValue(env, key))) missing.push(key);
    }
  }
  return missing;
}

/** 该键是否属于向导会询问的集合（核心 + 两个邮件分支 + judge）。 */
function isWizardKey(key: string): boolean {
  return WIZARD_CORE_KEYS.includes(key) || ALIYUN_EMAIL_KEYS.includes(key) ||
    TENCENT_EMAIL_KEYS.includes(key) || JUDGE_KEYS.includes(key);
}

/** 迁移 `configuration_needs_interactive_input`（:390）：是否仍需向导补值。 */
export function wizardNeedsInteractiveInput(env: EnvValues): boolean {
  return wizardMissingKeys(env).length > 0;
}

/** {@link runConfigWizard} 的选项。 */
export interface WizardOptions {
  /** 标准输入是否连接终端；false 且缺必需输入时明确报错（#517 E10）。 */
  isTty: boolean;
  /** 覆盖"缺哪些键即拒绝"的清单；缺省用 {@link wizardMissingKeys}。 */
  required?: string[];
  /** 给出时在确认后原子写入该 .env.prod（父目录自动创建）。 */
  envFile?: string;
  /** 自动探测到的默认 IP（对应 `detect_default_ipv4`）。 */
  defaultIp?: string;
  /** 语义色主题（T8）；缺省按 auto 现算。 */
  theme?: Theme;
}

/** {@link runConfigWizard} 结果。 */
export interface WizardResult {
  cancelled: boolean;
  /** 向导结束后的完整键值（含调用方传入的当前值）。 */
  values: EnvValues;
  wroteEnvFile: boolean;
}

/** 邮件服务选择归一化：返回 null 表示非法输入需重问。 */
function normalizeEmailProvider(raw: string): string | null {
  switch (raw) {
    case "aliyun":
    case "tencent":
      return raw;
    case "disabled":
    case "skip":
    case "none":
    case "跳过":
    case "暂不配置":
      return "disabled";
    default:
      return null;
  }
}

/** 邮件服务的提示文案（deploy.sh:336-342 的 `email_provider_prompt_label`）。 */
function emailProviderPromptLabel(current: string): string {
  switch (current) {
    case "aliyun":
      return "邮件服务（当前已配置阿里云；回车继续使用，输入 skip 暂不配置）";
    case "tencent":
      return "邮件服务（当前已配置腾讯云；回车继续使用，输入 skip 暂不配置）";
    default:
      return "邮件服务（可选阿里云/腾讯云；直接回车暂不配置）";
  }
}

/** 取 socket 的 gid（bash `stat -c %g`）；不可得时返回 null。 */
async function socketGid(path: string): Promise<string | null> {
  try {
    const st = await Deno.stat(path);
    return String(st.gid ?? "");
  } catch {
    return null;
  }
}

/**
 * 把键值表转成 T3 `writeEnvFileAtomic` 需要的 Map（丢弃 undefined）。
 *
 * T12 起导出：`lifecycle.ts` 的 install 与向导回填共用这一份实现，避免同形
 * 函数在 `config.ts` / `lifecycle.ts` 各存一份（去重）。
 */
export function toEntries(values: EnvValues): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) entries.set(key, value);
  }
  return entries;
}

/** 带默认值的文本输入：默认值为空串时不写 `[ ]`（与 bash 无默认提示一致）。 */
function promptText(
  io: PromptIO,
  label: string,
  fallback: string,
): Promise<string> {
  return input(io, label, fallback === "" ? undefined : fallback);
}

/**
 * 迁移 `configure_env_interactive`（:429-595）。
 *
 * **非 TTY**：缺必需输入时直接抛错并附上缺少的键，绝不进入交互循环
 * （#517 E10；错误文本复用 T9 `init/non_interactive.ts` 的
 * {@link nonInteractiveAdvice}），也不写任何输出。
 * 配置已完整时零输出返回当前值（无需交互）。
 *
 * **TTY**：按 bash 顺序询问版本 → 网站地址 → HTTPS → 邮件服务 → Judge →
 * 确认写入。返回值是"待落盘键值"；只有显式传入 `envFile` 才写盘（T12+ 决定
 * 是暂存还是直接提交，本模块不实现生命周期动作）。
 *
 * 邮件条件键清单来自 T2 schema 的 {@link ALIYUN_EMAIL_KEYS} /
 * {@link TENCENT_EMAIL_KEYS}（唯一事实源），本模块不再自带第二份 key 数组。
 *
 * 复填语义（bash `reset_existing`）通过"传入空 env"表达：传入当前 env 即
 * "补齐缺失"，非占位的历史值成为默认值并在用户回车时复用。
 */
export async function runConfigWizard(
  io: PromptIO,
  env: EnvValues,
  opts: WizardOptions,
): Promise<WizardResult> {
  const values: EnvValues = { ...env };

  if (!opts.isTty) {
    // wizardMissingKeys 只产出向导会问的键（核心 + 当前邮件分支 + judge），
    // 过滤是冗余的，但保留显式清单便于后续给 opts.required 传自定义集合。
    const required = opts.required ??
      wizardMissingKeys(env).filter((key) => isWizardKey(key));
    if (required.length > 0) {
      const advice = nonInteractiveAdvice(false, false);
      const message = `${
        advice?.message ?? "检测到非交互环境"
      }\n缺少必需配置：${required.join("、")}`;
      throw new Error(message);
    }
    return { cancelled: false, values, wroteEnvFile: false };
  }

  const theme = opts.theme ?? createTheme("auto");
  io.write(theme.color("primary", "== 填写生产配置 ==") + "\n");

  // 1. 安装版本
  const version = await promptText(
    io,
    "安装版本（例如 v0.8.0-rc.1）",
    currentConfigValue(values, "NOJ_VERSION"),
  );
  values["NOJ_VERSION"] = version;

  // 2. 网站地址
  const domainFallback = currentConfigValue(values, "DOMAIN") ||
    (opts.defaultIp ?? "");
  const domain = await promptText(
    io,
    "网站地址（域名或服务器 IP，不要写 https://；可直接回车使用检测到的 IP）",
    domainFallback,
  );
  if (!isSiteAddress(domain)) {
    throw new Error(
      "网站地址必须是域名或服务器 IP，例如 oj.example.com 或 192.0.2.10",
    );
  }
  values["DOMAIN"] = domain;
  if (isIpv4Address(domain)) {
    io.write(
      theme.status(
        "warning",
        "当前使用服务器 IP；正式环境仍需 HTTPS，建议以后换成域名并配置证书",
      ) + "\n",
    );
  }

  // 3. HTTPS / APP_URL
  const sslDefault = !currentConfigValue(values, "APP_URL").startsWith(
    "http://",
  );
  const https = await confirm(
    io,
    "是否使用 HTTPS（证书需在宝塔或反向代理中配置）",
    sslDefault,
  );
  values["NOJ_ALLOW_INSECURE_HTTP"] = String(!https);
  const appUrl = `${https ? "https" : "http"}://${domain}`;
  values["APP_URL"] = appUrl;
  values["CORS_ALLOWED_ORIGINS"] = appUrl;
  if (!https) {
    io.write(
      theme.status(
        "warning",
        "已选择临时 HTTP；登录信息可能被窃取，正式使用前请配置 HTTPS",
      ) +
        "\n",
    );
  }

  // 4. 邮件服务
  const currentEmail = currentConfigValue(values, "EMAIL_PROVIDER");
  let emailProvider = "disabled";
  for (;;) {
    const raw = await promptText(
      io,
      emailProviderPromptLabel(currentEmail),
      currentEmail === "" ? "disabled" : currentEmail,
    );
    const normalized = normalizeEmailProvider(raw);
    if (normalized === null) {
      io.write("请输入 aliyun、tencent，或选择暂不配置\n");
      continue;
    }
    emailProvider = normalized;
    break;
  }
  // bash 仅当"当前值非空且与本次选择相同"时才复用分支（:491）。
  const emailReused = currentEmail === emailProvider &&
    (emailProvider === "aliyun" || emailProvider === "tencent");
  const canReuse = (key: string): boolean =>
    emailReused && currentConfigValue(values, key) !== "";

  values["EMAIL_PROVIDER"] = emailProvider;
  if (emailProvider === "aliyun") {
    if (!canReuse("ALIBABA_ACCESS_KEY_ID")) {
      values["ALIBABA_ACCESS_KEY_ID"] = await secretInput(
        io,
        "阿里云 Access Key ID",
      );
    }
    if (!canReuse("ALIBABA_ACCESS_KEY_SECRET")) {
      values["ALIBABA_ACCESS_KEY_SECRET"] = await secretInput(
        io,
        "阿里云 Access Key Secret",
      );
    }
    if (!canReuse("ALIBABA_FROM_EMAIL")) {
      values["ALIBABA_FROM_EMAIL"] = await promptText(
        io,
        "阿里云发件邮箱",
        currentConfigValue(values, "ALIBABA_FROM_EMAIL"),
      );
    }
  } else if (emailProvider === "tencent") {
    if (!canReuse("TENCENT_SECRET_ID")) {
      values["TENCENT_SECRET_ID"] = await secretInput(io, "腾讯云 Secret ID");
    }
    if (!canReuse("TENCENT_SECRET_KEY")) {
      values["TENCENT_SECRET_KEY"] = await secretInput(io, "腾讯云 Secret Key");
    }
    if (!canReuse("TENCENT_FROM_EMAIL")) {
      values["TENCENT_FROM_EMAIL"] = await promptText(
        io,
        "腾讯云发件邮箱",
        currentConfigValue(values, "TENCENT_FROM_EMAIL"),
      );
    }
    if (!canReuse("TENCENT_REGION")) {
      values["TENCENT_REGION"] = await promptText(
        io,
        "腾讯云 Region",
        currentConfigValue(values, "TENCENT_REGION") || "ap-guangzhou",
      );
    }
  } else {
    for (const key of ALL_EMAIL_KEYS) values[key] = "";
    io.write(
      theme.status(
        "warning",
        "已跳过邮件服务；密码找回邮件暂时不可用，可稍后在后台配置",
      ) + "\n",
    );
  }

  // 5. Judge
  const currentJudge = currentConfigValue(values, "JUDGE_ENABLED");
  const judgeDefault = judgeEnabledFrom({ JUDGE_ENABLED: currentJudge });
  const judgeInstall = await confirm(
    io,
    "是否安装评测服务 Judge（没有评测 Docker 服务也可以跳过）",
    judgeDefault,
  );
  values["JUDGE_ENABLED"] = String(judgeInstall);

  if (judgeInstall) {
    const socket = await promptText(
      io,
      "评测服务连接位置（一般直接回车）",
      currentConfigValue(values, "JUDGE_DOCKER_SOCKET") ||
        "/run/noj-judge/docker.sock",
    );
    values["JUDGE_DOCKER_SOCKET"] = socket;

    const gidFallback = currentConfigValue(values, "JUDGE_DOCKER_SOCKET_GID") ||
      (await socketGid(socket)) || "10001";
    const gid = await promptText(
      io,
      "评测服务连接编号（一般直接回车）",
      gidFallback,
    );
    if (!/^[0-9]+$/.test(gid)) {
      throw new Error("Judge Docker socket GID 必须是数字");
    }
    values["JUDGE_DOCKER_SOCKET_GID"] = gid;
  } else {
    io.write("已跳过 Judge 配置\n");
  }

  // 6. 确认写入
  const confirmed = await confirm(
    io,
    "是否写入配置？（Y=写入并继续部署，N=取消）",
    true,
  );
  if (!confirmed) {
    io.write("已取消本次部署，正式配置未修改\n");
    return { cancelled: true, values, wroteEnvFile: false };
  }

  let wroteEnvFile = false;
  if (opts.envFile !== undefined) {
    const parent = dirname(opts.envFile);
    // T3 carry-forward：writeEnvFileAtomic 不 mkdir 父目录，调用方保证存在。
    if (parent !== "" && parent !== ".") {
      await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
    }
    await writeEnvFileAtomic(opts.envFile, toEntries(values));
    wroteEnvFile = true;
  }
  io.write("配置已写入，正在继续校验和启动服务\n");
  return { cancelled: false, values, wroteEnvFile };
}
