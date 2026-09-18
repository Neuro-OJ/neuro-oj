/**
 * 生产生命周期动作（T12 起）：`install` 是**唯一**生产安装路径。
 *
 * 背景（spec R4 + §3.3 洞 2）：删除 `setup.sh` / `install.sh` 后，用户手动
 * 下载 `noj-cli` 二进制，在空目录执行 `noj-cli install --dir <dir>` 即应完成
 * 安装。这要求 install 自己补齐 compose 文件（T9 bootstrap）、自己完成配置
 * 校验与向导（T11），再驱动 compose（T10）。
 *
 * 装配顺序（对照 deploy.sh 的 `install()` :999-1026 与 `initialize_env` :597-656）：
 * 1. **bootstrap**：T9 {@link downloadReleaseFiles} 拉取并 SHA-256 校验
 *    `docker-compose.prod.yml` + `.env.prod.example`；
 * 2. **seed-env**（仅首次）：由模板生成 `.env.prod`（600）并写入自动生成的
 *    强随机密钥（deploy.sh :622-644）；
 * 3. **configure**：T11 {@link runConfigWizard} 交互向导（仅 TTY；非交互缺配置
 *    直接报错且**零写入**）；
 * 4. **passphrase**：T11 {@link ensureBackupPassphrase}（deploy.sh :920-953）；
 * 5. **validate**：T11 {@link checkRequiredValues} + {@link checkJudgeSocket} +
 *    `compose config`（deploy.sh :684-766 / :893-914）；
 * 6. **verify-images**：T11 {@link verifyImageSignatures}（deploy.sh :837-874）；
 * 7. **compose-pull / compose-up**：T10 {@link composeUp} 等（deploy.sh
 *    `run_compose pull` + `wait_for_stack` :981-992）；
 * 8. **record-metadata**：T11 {@link recordDeploymentMetadata}（deploy.sh :875-891）；
 * 9. **register**：PATH 注册（production.sh:97-131 的 `register_command`）。
 *
 * ## 上游 CARRY-FORWARD（全部落实）
 *
 * 1. **T9**：`downloadReleaseFiles` 的 `overwrite` 默认 false（拒绝覆盖）→
 *    首次安装传 `overwrite:false`，**升级路径（目录已有 `.env.prod`）显式传
 *    `overwrite:true`**。资产名沿用 T9 的 `RELEASE_FILES`（各带 `.sha256`）。
 * 2. **T11**：调用顺序 **先 `judgeEnabledError` → 再 `checkRequiredValues`
 *    （内部即 `validateEnv`）**；judge 未设置/空串 = 启用。口令回填**仅由进程
 *    环境变量抑制**（`configuredFromEnv`），`--passphrase-file` 不抑制；口令
 *    路径经 `targetFile` 注入。`.env.prod` 权限经 `checkEnvFileMode(mode, file)`
 *    校验 600/400。`cosignAvailable` 在 T11 缺省 true，本模块在生产路径上注入
 *    真实探测（见 {@link InstallOptions.cosignAvailable}），**不静默**。
 * 3. **T10**：`ComposeResult = CmdResult | string[]`，读结果前一律
 *    `Array.isArray` 收窄；runner 不替调用方打印，本模块自己写 stdout/stderr。
 *
 * ## 与 bash 的有意差异（R3 逐项核对后保留，已在 task-12 报告登记）
 *
 * - **非交互 + 缺配置 → 零写入**：bash `initialize_env`（:646-655）会先由模板
 *   生成 `.env.prod` 再 `exit 2`；本实现按 task-12 brief 的明文要求**在写入前
 *   直接报错**，避免留下半成品配置。
 * - **`wait_for_stack` 的附加旗标**：bash 先 `up -d --wait --wait-timeout 180
 *   --remove-orphans`，再 `up -d --force-recreate --no-deps nginx`；本模块复用
 *   T10 的 `composeUp`（`up -d --wait`），不另造 compose 封装。
 * - **不把运行中的二进制复制进 `<dir>/bin/noj-cli`**：那是 install.sh
 *   `download_cli`/`install_cli` 的职责，随 R4 删除；二进制由用户手动下载
 *   （R4），跨版本同步归 T16。PATH 注册严格照 `register_command` 语义：目标
 *   不存在时按「源码运行模式」告警并跳过。
 */

import { join } from "@std/path";
import {
  checkEnvFileMode,
  ENV_KEYS,
  JUDGE_KEYS,
  judgeEnabledError,
} from "../core/config-schema.ts";
import type { FilePermissionVerdict } from "../core/config-schema.ts";
import { readEnvFile, writeEnvFileAtomic } from "../core/env-file.ts";
import { randomKey } from "../init/secrets.ts";
import { nonInteractiveAdvice } from "../init/non_interactive.ts";
import { PRODUCTION_MARKERS } from "../profile.ts";
import type { CommandRunner } from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import {
  downloadReleaseFiles,
  RELEASE_FILES,
  validateTargetDir,
} from "./bootstrap.ts";
import type { Fetcher } from "./bootstrap.ts";
import { composeArgs, composeConfig, composeUp } from "./compose.ts";
import type { ComposeOptions, ComposeResult } from "./compose.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "./compose.ts";
import {
  backupPassphrasePath,
  checkJudgeSocket,
  checkRequiredValues,
  ensureBackupPassphrase,
  generateSecret,
  recordDeploymentMetadata,
  runConfigWizard,
  verifyImageSignatures,
  wizardNeedsInteractiveInput,
} from "./config.ts";
import type {
  EnvValues,
  RequiredValuesReport,
  VerifiedDigest,
} from "./config.ts";

/** install 的步骤名（顺序即执行顺序，也是 `InstallResult.steps` 的顺序）。 */
export type InstallStepName =
  | "bootstrap"
  | "seed-env"
  | "configure"
  | "passphrase"
  | "validate"
  | "verify-images"
  | "compose-pull"
  | "compose-up"
  | "record-metadata"
  | "register";

/** 单个已完成的安装步骤。 */
export interface InstallStep {
  name: InstallStepName;
  /** 仅 `bootstrap`：是否以覆盖模式拉取资产（T9 carry-forward）。 */
  overwrite?: boolean;
  /** 该步骤涉及/产出的路径（便于报告与文件系统断言）。 */
  paths?: string[];
}

/** PATH 注册结果。 */
export interface PathRegistration {
  /** 实际创建（或已存在且正确）的软链接路径；未注册时为 null。 */
  path: string | null;
  /** 用户可见的告警（未覆盖、无法注册、源码运行模式等）。 */
  warnings: string[];
}

/** {@link install} 的结果。 */
export interface InstallResult {
  /** 归一化后的安装目录（无尾斜杠）。 */
  dir: string;
  /** true = 首次安装（本次生成 `.env.prod`）；false = 升级（复用既有配置）。 */
  created: boolean;
  /** 已完成步骤（顺序即执行顺序）。 */
  steps: InstallStep[];
  envFile: string;
  composeFile: string;
  /** 通过 cosign 验签的镜像 digest（关闭验签时为空）。 */
  verified: VerifiedDigest[];
  /** `compose up` 的退出码（真实执行；本模块不做 dryRun）。 */
  composeUpCode: number;
  /** PATH 注册结果（best-effort，失败不抛错）。 */
  registration: PathRegistration;
}

/** {@link install} 的注入点：一切外部访问（网络/命令/IO/路径）都可替换。 */
export interface InstallOptions {
  /** 目标安装目录（`--dir`）。 */
  dir: string;
  /** 仓库主页地址（T9 `validateRepository` 要求 HTTPS）。 */
  repository: string;
  /** Release ref，同时作为新装 `.env.prod` 的 `NOJ_VERSION` 默认值。 */
  ref: string;
  /** 交互通道（向导与进度输出）。 */
  io: PromptIO;
  /** 外部命令注入点（docker / cosign / lsof）。 */
  runner: CommandRunner;
  /** 资产下载器；缺省为全局 fetch（测试必须注入）。 */
  fetcher?: Fetcher;
  /** 显示传入的终端判定；缺省用 `Deno.stdin.isTerminal()`。 */
  isTty?: boolean;
  /** `--non-interactive`：绝不进入向导，缺配置直接报错且零写入。 */
  nonInteractive?: boolean;
  /** `--passphrase-file` 指定的口令文件路径（经 `targetFile` 注入 T11）。 */
  passphraseFile?: string;
  /** 进程环境变量快照；缺省 `Deno.env.toObject()`。 */
  processEnv?: Record<string, string>;
  /**
   * cosign 可用性探测（`command -v cosign` 的等价注入）。
   *
   * 缺省实现用注入的 runner 执行 `cosign version` 并以退出码判定——**不猜**
   * true/false，也不 spawn shell（R1）。T11 侧缺省 true 是为了不改变其公开
   * 行为；生产接线由本模块补齐真实探测。
   */
  cosignAvailable?: () => Promise<boolean>;
  /** judge socket 存在性探测（T11 `checkJudgeSocket` 的注入点）。 */
  socketExists?: (path: string) => Promise<boolean>;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
  /** cosign 可执行名。 */
  cosignBin?: string;
  /** 全局命令目录；缺省取 `NOJ_BIN_DIR` 或 `/usr/local/bin`。 */
  binDir?: string;
  /** 用户 home；缺省取进程环境 `HOME`。 */
  userHome?: string;
  /** 安装版 CLI 路径（PATH 注册目标）；缺省 `<dir>/bin/noj-cli`。 */
  cliBinary?: string;
  /** 告警汇聚点（缺省丢弃；生产由 CLI 接到 stderr）。 */
  warn?: (message: string) => void;
  /** 元数据时间戳（测试注入固定值）。 */
  now?: Date;
  /** 新装时的 `NOJ_VERSION` 默认值；缺省与 `ref` 相同（对照 install.sh 传 REF）。 */
  defaultVersion?: string;
}

/** PATH 追加行（逐字对照 production.sh:90）。 */
export const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/** 首次安装自动生成强随机值的键（deploy.sh :627-635）。 */
const GENERATED_SECRET_KEYS: readonly string[] = [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "MINIO_ROOT_PASSWORD",
  "S3_SECRET_KEY",
  "JWT_SECRET",
  "TFA_ENCRYPTION_KEY",
  "NOJ_LLM_SERVICE_TOKEN",
  "NOJ_LLM_STORE_KEY",
];

// ---------------- 通用小工具 ----------------

/** 读取 `.env.prod` 为 {@link EnvValues}。 */
async function readEnvValues(path: string): Promise<EnvValues> {
  const map = await readEnvFile(path);
  const out: EnvValues = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

/** 把键值表转成 T3 `writeEnvFileAtomic` 需要的 Map（丢弃 undefined）。 */
function toEntries(
  values: Record<string, string | undefined>,
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) entries.set(key, value);
  }
  return entries;
}

/** `-f` 语义的普通文件判定。 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * 读文件的八进制权限串（`stat -c %a` 的等价）。
 *
 * 返回 `{ isFile, mode }`：`mode` 读不出时为 null，交由 T11
 * {@link checkEnvFileMode} 产出与 bash :658-665 一致的报错。
 */
async function statMode(path: string): Promise<{
  isFile: boolean;
  mode: string | null;
}> {
  try {
    const st = await Deno.stat(path);
    return {
      isFile: st.isFile,
      mode: ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0"),
    };
  } catch {
    return { isFile: false, mode: null };
  }
}

/**
 * 目录是否为**完整**生产安装目录（T5 {@link PRODUCTION_MARKERS} 全在）。
 *
 * T12 carry-forward（T5）：复用 T5 导出的唯一事实源，**不新增第三份标记清单**。
 * 该判定只决定「首次安装（需由模板生成 .env.prod）」还是「升级（复用既有配置）」。
 */
async function isInstallationDir(dir: string): Promise<boolean> {
  for (const marker of PRODUCTION_MARKERS) {
    if (!(await isFile(join(dir, marker)))) return false;
  }
  return true;
}

/**
 * 目录内是否已有 T9 的任一 Release 资产（决定 `overwrite`，T9 carry-forward）。
 *
 * 与 {@link isInstallationDir} 刻意分开：
 * - **是否 seed** 由 T5 的完整标记集决定（两件套齐全才算已安装）；
 * - **是否覆盖** 由 T9 自己的资产清单决定 —— 半成品目录（例如上次安装中途
 *   失败，只留下 compose）若按「未安装」传 `overwrite:false`，T9 会拒绝覆盖并
 *   卡死重试。这里有资产就已经不是"空目录首装"，必须允许覆盖。
 */
async function hasReleaseAssets(dir: string): Promise<boolean> {
  for (const asset of RELEASE_FILES) {
    if (await isFile(join(dir, asset))) return true;
  }
  return false;
}

/** 该路径是否为可执行普通文件（对应 bash `[[ -x ]]`）。 */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile && ((st.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** 首次安装缺配置时的可操作报错（复用 T9 `nonInteractiveAdvice` 文案）。 */
function missingConfigError(): Error {
  const advice = nonInteractiveAdvice(false, false);
  const required = [...ENV_KEYS.map((spec) => spec.key), ...JUDGE_KEYS];
  return new Error(
    `${advice?.message ?? "检测到非交互环境"}\n缺少必需配置：${
      required.join("、")
    }`,
  );
}

// ---------------- bootstrap / 配置 ----------------

/**
 * 由 `.env.prod.example` 生成受保护的 `.env.prod`（deploy.sh :622-644）。
 *
 * 顺序：模板正文落盘（600）→ 自动生成强随机值就地覆盖 → 覆盖
 * `MINIO_ROOT_USER`/`S3_ACCESS_KEY` 的随机后缀。占位值因此被真实密钥替换。
 */
async function seedEnvFile(
  envFile: string,
  templateFile: string,
  defaultVersion: string | undefined,
): Promise<void> {
  if (!(await isFile(templateFile))) {
    throw new Error(`找不到生产配置模板：${templateFile}`);
  }
  const template = await Deno.readTextFile(templateFile);
  const file = await Deno.open(envFile, {
    create: true,
    write: true,
    truncate: true,
    mode: 0o600,
  });
  try {
    await file.write(new TextEncoder().encode(template));
  } finally {
    file.close();
  }
  await Deno.chmod(envFile, 0o600);

  const entries = new Map<string, string>();
  for (const key of GENERATED_SECRET_KEYS) {
    entries.set(key, generateSecret());
  }
  entries.set("MINIO_ROOT_USER", "nojminio" + randomKey(6));
  entries.set("S3_ACCESS_KEY", "nojs3" + randomKey(6));
  if (defaultVersion !== undefined && defaultVersion !== "") {
    entries.set("NOJ_VERSION", defaultVersion);
  }
  await writeEnvFileAtomic(envFile, entries);
}

// ---------------- PATH 注册（production.sh:97-131） ----------------

/** `link_command` 的三态：ok=已就绪 / refuse=拒绝覆盖 / cannot=无法创建。 */
type LinkStatus = "ok" | "refuse" | "cannot";

/**
 * 在 `binDir` 下建立 `noj-cli` → `target` 软链接（逐字对照 `link_command`）。
 *
 * - 已是软链接且指向同一目标 → `ok`（幂等）；指向他处 → `refuse`；
 * - 存在同名非软链接 → `refuse`（绝不覆盖）；
 * - `mkdir -p` 或 `ln -s` 失败 → `cannot`（调用方据此回落用户目录）。
 */
async function linkCommand(
  binDir: string,
  target: string,
): Promise<LinkStatus> {
  const link = join(binDir, "noj-cli");
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.lstat(link);
  } catch {
    st = null;
  }
  if (st !== null && st.isSymlink) {
    const existing = await Deno.readLink(link).catch(() => "");
    return existing === target ? "ok" : "refuse";
  }
  if (st !== null) return "refuse";
  try {
    await Deno.mkdir(binDir, { recursive: true });
  } catch {
    return "cannot";
  }
  try {
    await Deno.symlink(target, link);
  } catch {
    return "cannot";
  }
  return "ok";
}

/**
 * 把 `~/.local/bin` 追加进 `~/.profile`（`add_user_path` :86-95）。
 *
 * `grep -Fqx` 等价：整行比较，已存在则不重复追加。返回是否成功。
 */
async function addUserPath(userHome: string): Promise<boolean> {
  if (userHome === "") return false;
  const profile = join(userHome, ".profile");
  let existing = "";
  try {
    existing = await Deno.readTextFile(profile);
  } catch {
    existing = "";
  }
  if (existing.split("\n").some((line) => line === PATH_LINE)) return true;
  try {
    await Deno.writeTextFile(
      profile,
      `\n# Neuro OJ command\n${PATH_LINE}\n`,
      { append: true, create: true },
    );
  } catch {
    return false;
  }
  return true;
}

/**
 * 迁移 `register_command`（production.sh:97-131）。
 *
 * 目标 `<dir>/bin/noj-cli` 不存在/不可执行时按「源码运行模式」告警并跳过
 * （不把 `deno` 自身误注册成命令）。优先全局目录，权限不足回落 `~/.local/bin`；
 * 两个目录都存在同名且指向他处的命令时**拒绝覆盖**并告警（不静默成功）。
 */
export async function registerCommand(
  opts: {
    cliBinary: string;
    binDir: string;
    userHome: string;
    warn: (message: string) => void;
  },
): Promise<PathRegistration> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.warn(message);
  };

  if (!(await isExecutableFile(opts.cliBinary))) {
    warn("当前为源码运行模式，未注册 PATH；安装版 CLI 位于 " + opts.cliBinary);
    return { path: null, warnings };
  }

  const global = await linkCommand(opts.binDir, opts.cliBinary);
  if (global === "ok") {
    return { path: join(opts.binDir, "noj-cli"), warnings };
  }
  if (global === "refuse") {
    warn(`未覆盖已有命令：${join(opts.binDir, "noj-cli")}`);
    return { path: null, warnings };
  }

  if (opts.userHome !== "") {
    const userBin = join(opts.userHome, ".local/bin");
    const user = await linkCommand(userBin, opts.cliBinary);
    if (user === "ok") {
      const link = join(userBin, "noj-cli");
      if (await addUserPath(opts.userHome)) {
        return { path: link, warnings };
      }
      warn(`已创建用户命令：${link}，但无法自动更新 PATH，请手动将其加入 PATH`);
      return { path: link, warnings };
    }
    if (user === "refuse") {
      warn(`未覆盖已有命令：${join(userBin, "noj-cli")}`);
      return { path: null, warnings };
    }
  }

  warn(`无法注册 noj-cli 到 PATH；部署已完成，可直接运行 ${opts.cliBinary}`);
  return { path: null, warnings };
}

// ---------------- install ----------------

/**
 * T11 配置校验入口：**先** `judgeEnabledError` → **再** `checkRequiredValues`。
 *
 * 顺序是 T11 carry-forward 的硬要求：`validateEnv`（`checkRequiredValues` 的第一
 * 步）装不下 `JUDGE_ENABLED` 的枚举错误，非法值必须先被 `judgeEnabledError`
 * 拒绝。judge **未设置/空串 = 启用**（deploy.sh:679）。
 */
function assertConfiguration(env: EnvValues): RequiredValuesReport {
  const judgeError = judgeEnabledError(env["JUDGE_ENABLED"]);
  if (judgeError !== null) throw new Error(judgeError);
  const report = checkRequiredValues(env);
  if (!report.ok) {
    throw new Error("生产配置校验失败：\n" + report.errors.join("\n"));
  }
  return report;
}

/** 真实 cosign 探测：经注入 runner 执行 `cosign version`（无 shell）。 */
function probeCosign(
  runner: CommandRunner,
  cosignBin: string,
): () => Promise<boolean> {
  return async () => (await runner.run(cosignBin, ["version"])).code === 0;
}

/**
 * 执行一条 compose 子命令（`pull` / `up` 由 T10 的 `composeUp` 覆盖）。
 *
 * 必须在调用点用 `Array.isArray` 收窄 `ComposeResult`（T10 carry-forward）。
 */
function runComposeSub(
  runner: CommandRunner,
  options: ComposeOptions,
  command: string[],
): Promise<ComposeResult> {
  return runner.run("docker", composeArgs({ ...options, command }));
}

/** 把 compose 输出原样转给调用方（T10 carry-forward：runner 不打印）。 */
function emitComposeOutput(io: PromptIO, result: ComposeResult): void {
  if (Array.isArray(result)) return;
  if (result.stdout !== "") io.write(result.stdout);
  if (result.stderr !== "") io.write(result.stderr);
}

/**
 * 唯一生产安装路径：串起 T9 → T11 → T10，落状态并输出结果。
 *
 * 所有外部访问都经注入点：网络走 `fetcher`、命令走 `runner`、交互走 `io`、
 * 路径由调用方给出。测试因此不触网、不起容器。
 */
export async function install(opts: InstallOptions): Promise<InstallResult> {
  // 先于一切副作用拒绝 `/`、`.`、`..`、空串（T9 `validateTargetDir`）。
  const dir = validateTargetDir(opts.dir);
  const envFile = join(dir, PROD_ENV_FILE);
  const composeFile = join(dir, PROD_COMPOSE_FILE);
  const templateFile = join(dir, ".env.prod.example");
  const processEnv = opts.processEnv ?? Deno.env.toObject();
  const warn = opts.warn ?? (() => {});
  const io = opts.io;
  const runner = opts.runner;
  const steps: InstallStep[] = [];

  // 已安装判定复用 T5 的 {@link PRODUCTION_MARKERS} 唯一事实源：
  // 目录同时含 docker-compose.prod.yml 与 .env.prod 才算「已安装 → 复用配置」。
  const installed = await isInstallationDir(dir);
  const created = !installed;
  // T9 carry-forward：overwrite 由 T9 自己的资产清单决定（首次安装 false）。
  const overwrite = await hasReleaseAssets(dir);

  if (!installed) {
    // 首次安装：无模板可读，非交互不可能补齐配置 → 写盘前明确报错（零写入）。
    const tty = opts.isTty ?? Deno.stdin.isTerminal();
    if (opts.nonInteractive === true || !tty) throw missingConfigError();
  }

  // ---- 既有 .env.prod：权限不合格时必须在任何安装动作之前拒绝 ----
  if (installed) {
    const { isFile: regular, mode } = await statMode(envFile);
    if (!regular) {
      throw new Error(`生产配置路径不是普通文件：${envFile}`);
    }
    const verdict: FilePermissionVerdict = checkEnvFileMode(mode, envFile);
    if (verdict.kind !== "ok") throw new Error(verdict.message);

    // 非交互下若既有配置本就不完整，先于一切写入报错（brief 明文要求）。
    // 校验入口与步骤 5 共用，因此 judgeEnabledError → validateEnv 的顺序不变。
    if (opts.nonInteractive === true) {
      assertConfiguration(await readEnvValues(envFile));
    }
  }

  // ---- 1. bootstrap（T9）：资产下载 + SHA-256 校验 ----
  // T9 carry-forward：目录里已有任一 Release 资产 → 显式 overwrite:true（升级/
  // 半成品重试）；真正的空目录首装才保持 false（拒绝静默覆盖用户文件）。
  await downloadReleaseFiles({
    repository: opts.repository,
    ref: opts.ref,
    targetDir: dir,
    overwrite,
    fetcher: opts.fetcher,
  });
  steps.push({
    name: "bootstrap",
    overwrite,
    paths: [composeFile, templateFile],
  });

  // ---- 2. seed-env（仅首次）：由模板生成 600 的 .env.prod ----
  if (created) {
    await seedEnvFile(
      envFile,
      templateFile,
      opts.defaultVersion ?? opts.ref,
    );
    steps.push({ name: "seed-env", paths: [envFile] });
  }

  // ---- 3. configure（T11 向导）：仅 TTY 且确有缺失时进入 ----
  let env = await readEnvValues(envFile);
  if (opts.nonInteractive !== true && (opts.isTty ?? Deno.stdin.isTerminal())) {
    if (wizardNeedsInteractiveInput(env)) {
      await runConfigWizard(io, env, { isTty: true, envFile });
      env = await readEnvValues(envFile);
    }
  }
  steps.push({ name: "configure", paths: [envFile] });

  // ---- 4. passphrase（T11）：旗标经 targetFile 注入；仅进程环境抑制回填 ----
  const passphraseTarget = backupPassphrasePath({
    flag: opts.passphraseFile,
    explicit: processEnv["NOJ_BACKUP_PASSPHRASE_FILE"],
    configured: env["NOJ_BACKUP_PASSPHRASE_FILE"],
  });
  const ensured = await ensureBackupPassphrase(env, {
    targetFile: passphraseTarget,
    configuredFromEnv: (processEnv["NOJ_BACKUP_PASSPHRASE_FILE"] ?? "") !== "",
  });
  if (ensured.error !== null) throw new Error(ensured.error);
  if (ensured.created) {
    warn("请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照");
  }
  if (ensured.envUpdate !== null) {
    await writeEnvFileAtomic(envFile, toEntries(ensured.envUpdate));
    env = await readEnvValues(envFile);
  }
  steps.push({ name: "passphrase", paths: [ensured.path] });

  // ---- 5. validate（T11）：judgeEnabledError → checkRequiredValues ----
  const report = assertConfiguration(env);
  if (report.judgeEnabled) {
    const socket = await checkJudgeSocket(env, {
      socketExists: opts.socketExists,
    });
    if (!socket.ok) {
      throw new Error(socket.error ?? "Judge Docker socket 校验失败");
    }
  }
  const composeOptions: ComposeOptions = {
    composeFile,
    envFile,
    judge: report.judgeEnabled,
  };
  const configCheck = await composeConfig(runner, composeOptions);
  if (!Array.isArray(configCheck) && configCheck.code !== 0) {
    throw new Error(
      "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件：" +
        configCheck.stderr.trim(),
    );
  }
  steps.push({ name: "validate", paths: [envFile, composeFile] });

  // ---- 6. verify-images（T11）：cosign 缺失/失败必须可见 ----
  const verify = await verifyImageSignatures(env, {
    runner,
    cosignAvailable: opts.cosignAvailable ??
      probeCosign(runner, opts.cosignBin ?? "cosign"),
    dockerBin: opts.dockerBin,
    cosignBin: opts.cosignBin,
    warn,
  });
  if (!verify.ok) {
    const message = verify.error ?? "生产镜像签名校验失败";
    warn(message);
    throw new Error(message);
  }
  steps.push({ name: "verify-images" });

  // ---- 7. compose pull + up（T10）----
  const pulled = await runComposeSub(runner, composeOptions, ["pull"]);
  emitComposeOutput(io, pulled);
  if (!Array.isArray(pulled) && pulled.code !== 0) {
    throw new Error(
      "拉取生产镜像失败：" +
        (pulled.stderr.trim() || ("docker compose 退出码 " + pulled.code)),
    );
  }
  steps.push({ name: "compose-pull", paths: [composeFile] });

  const up = await composeUp(runner, composeOptions);
  emitComposeOutput(io, up);
  const composeUpCode = Array.isArray(up) ? 0 : up.code;
  if (!Array.isArray(up) && up.code !== 0) {
    throw new Error("服务启动或健康检查失败，请执行 status 和 logs 排查");
  }
  steps.push({ name: "compose-up", paths: [composeFile] });

  // ---- 8. record-metadata（T11）：无验签结果时零副作用 ----
  const metadata = await recordDeploymentMetadata({
    version: env["NOJ_VERSION"] ?? "",
    at: opts.now ?? new Date(),
    verified: verify.digests,
    backupDir: join(dir, "backups"),
  });
  steps.push({
    name: "record-metadata",
    paths: metadata.path === null ? [] : [metadata.path],
  });

  // ---- 9. register（production.sh `register_command`）----
  const cliBinary = opts.cliBinary ?? join(dir, "bin/noj-cli");
  const registration = await registerCommand({
    cliBinary,
    binDir: opts.binDir ?? processEnv["NOJ_BIN_DIR"] ?? "/usr/local/bin",
    userHome: opts.userHome ?? processEnv["HOME"] ?? "",
    warn,
  });
  steps.push({ name: "register" });

  io.write("✓ 生产部署完成\n");
  return {
    dir,
    created,
    steps,
    envFile,
    composeFile,
    verified: verify.digests,
    composeUpCode,
    registration,
  };
}
