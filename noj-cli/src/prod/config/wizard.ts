/**
 * 交互式配置向导：缺失键判定、提示与 `runConfigWizard`。
 */

import { dirname } from "@std/path";
import {
  ALIYUN_EMAIL_KEYS,
  emailBranchKeys,
  isPlaceholder,
  JUDGE_KEYS,
  TENCENT_EMAIL_KEYS,
} from "../../core/config-schema.ts";
import { writeEnvFileAtomic } from "../../core/env-file.ts";
import { nonInteractiveAdvice } from "../advice.ts";
import { createTheme, type Theme } from "../../output/theme.ts";
import type { PromptIO } from "../../tui/io.ts";
import { confirm, input, secretInput } from "../../tui/widgets.ts";
import {
  currentConfigValue,
  type EnvValues,
  isIpv4Address,
  isSiteAddress,
  judgeEnabledFrom,
} from "./checks.ts";

// ---------------- 向导 ----------------

/** 向导的核心键（对应 `configuration_needs_interactive_input`:392）。 */
export const WIZARD_CORE_KEYS: readonly string[] = [
  "NOJ_VERSION",
  "DOMAIN",
  "APP_URL",
  "EMAIL_PROVIDER",
  "JUDGE_ENABLED",
];

/** 跳过邮件时清空的键（:548-549）。 */
export const ALL_EMAIL_KEYS: readonly string[] = [
  ...ALIYUN_EMAIL_KEYS,
  ...TENCENT_EMAIL_KEYS,
];

/** 迁移 `configuration_needs_interactive_input`（:390-417）。 */
export function wizardMissingKeys(env: EnvValues): string[] {
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
export function isWizardKey(key: string): boolean {
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
export function normalizeEmailProvider(raw: string): string | null {
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
export function emailProviderPromptLabel(current: string): string {
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
export async function socketGid(path: string): Promise<string | null> {
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
export function promptText(
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
