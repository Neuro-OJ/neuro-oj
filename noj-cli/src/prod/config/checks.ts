/**
 * 生产配置检查：必填项 / 站点地址 / Judge socket / 端口 / 宝塔面板探测与提示。
 */

import {
  EMAIL_PROVIDERS,
  emailBranchKeys,
  ENV_VALUE_RULES,
  isPlaceholder,
  JUDGE_KEYS,
  judgeEnabledError,
  validateEnv,
} from "../../core/config-schema.ts";
import { randomKey } from "../../util/random.ts";
import type { CommandRunner } from "../../runtime/command.ts";
import type { PromptIO } from "../../tui/io.ts";

/** 环境值表：.env.prod 的键值；`undefined` 表示键未设置。 */
export type EnvValues = Record<string, string | undefined>;

// ---------------- 内部复用原语 ----------------

/** 只保留已定义的值，供 T2 的 `validateEnv` 消费。 */
export function definedOnly(env: EnvValues): Record<string, string> {
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
export function judgeEnabledFrom(env: EnvValues): boolean {
  const probe = validateEnv({ JUDGE_ENABLED: env["JUDGE_ENABLED"] ?? "" });
  return probe.missing.includes(JUDGE_KEYS[0] ?? "JUDGE_DOCKER_SOCKET");
}

/** `-e` 语义的存在性探测（socket / 设备也算存在）。 */
export async function pathExists(path: string): Promise<boolean> {
  if (path === "") return false;
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** bash `current_config_value`（:275-285）：占位值归零，DOMAIN 的退出词归零。 */
export const EXIT_WORDS: ReadonlySet<string> = new Set([
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
export function currentConfigValue(env: EnvValues, key: string): string {
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
export const realPanelProbe: PanelProbe = {
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
export const BAOTA_GUIDANCE = [
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
