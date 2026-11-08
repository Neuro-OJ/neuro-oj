// install 命令族：唯一生产安装路径的步骤类型、注入点与 downloadReleaseFiles 驱动的安装编排。

import { join } from "@std/path";
import {
  checkEnvFileMode,
  ENV_KEYS,
  JUDGE_KEYS,
} from "../../core/config-schema.ts";
import type { FilePermissionVerdict } from "../../core/config-schema.ts";
import { writeEnvFileAtomic } from "../../core/env-file.ts";
import { randomKey } from "../../util/random.ts";
import { nonInteractiveAdvice } from "../advice.ts";
import type { CommandRunner } from "../../runtime/command.ts";
import type { PromptIO } from "../../tui/io.ts";
import {
  downloadReleaseFiles,
  RELEASE_FILES,
  validateTargetDir,
} from "../bootstrap.ts";
import type { Fetcher } from "../bootstrap.ts";
import type { ComposeResult } from "../compose.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "../compose.ts";
import {
  generateSecret,
  recordDeploymentMetadata,
  runConfigWizard,
  verifyImageSignatures,
  wizardNeedsInteractiveInput,
} from "../config.ts";
import type { EnvValues, VerifiedDigest } from "../config.ts";
import {
  assertConfiguration,
  composeOutputText,
  ensureCommandPassphrase,
  isFile,
  judgeEnabledFrom,
  prepareAndCheck,
  probeCommandCode,
  readEnvValues,
  runComposeSub,
  statMode,
  waitForStack,
} from "./steps.ts";
import { installCliBinary, registerCommand } from "./path.ts";
import type { PathRegistration } from "./path.ts";
import { resolveTargetConfig } from "./target.ts";

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
  // 把运行中的二进制安装到 `<dir>/bin/noj-cli`（`install.sh:558-565`）。
  // 位于 register 之前——register 以该文件存在为前提。
  | "install-cli"
  | "register";

/** 单个已完成的安装步骤。 */
export interface InstallStep {
  name: InstallStepName;
  /** 仅 `bootstrap`：是否以覆盖模式拉取资产（T9 carry-forward）。 */
  overwrite?: boolean;
  /** 该步骤涉及/产出的路径（便于报告与文件系统断言）。 */
  paths?: string[];
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
  /**
   * `waitForStack` 首段 `up` 的 compose 退出码（成功恒为真 0）。
   *
   * 该字段反映的是 `wait_for_stack` 的结果：它失败时本函数**抛错**（bash 同样
   * `fail` 退出），因此返回到调用方时必然是 0——不是"没执行"的占位值，
   * 也不是硬编码常量。本模块不做 dryRun。
   */
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
  /**
   * 运行中的可执行文件路径（`installCliBinary` 的源）；缺省 `Deno.execPath()`。
   *
   * 注入点存在的原因：测试环境里 `Deno.execPath()` 指向 `deno`，而源码运行模式
   * 下**不应**把它复制进安装目录（会得到一个跑不了本 CLI 的文件）——
   * 故必须能注入一个"看起来像已编译产物"的路径来覆盖真实路径。
   */
  executable?: string;
  /** 安装版 CLI 路径（PATH 注册目标）；缺省 `<dir>/bin/noj-cli`。 */
  cliBinary?: string;
  /** 告警汇聚点（缺省丢弃；生产由 CLI 接到 stderr）。 */
  warn?: (message: string) => void;
  /** 元数据时间戳（测试注入固定值）。 */
  now?: Date;
  /** 新装时的 `NOJ_VERSION` 默认值；缺省与 `ref` 相同（对照 install.sh 传 REF）。 */
  defaultVersion?: string;
}

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

// ---------------- 通用小工具（readEnvValues/isFile/statMode 已抽到 ./lifecycle/steps.ts） ----------------

/**
 * `.env.prod` 路径的**三态**判定（`stat` 而非 `-e`）。
 *
 * - `"regular"`：已存在且是普通文件 → **保留**（chmod 600，既不截断也不由模板
 *   重建）。对照 bash `initialize_env` :600-603 的
 *   `[[ -e "$ENV_FILE" ]]` → `chmod 600` → `ok "保留已有配置"` 后 `return 0`；
 * - `"exists"`：路径存在但**不是**普通文件（目录/设备/悬空软链接等）→ 显式报错
 *   （对照 bash :601 `[[ -f "$ENV_FILE" ]] || fail "生产配置路径不是普通文件"`）；
 * - `"absent"`：不存在 → 由模板 seed。
 *
 * **为什么不再用 T5 的 `PRODUCTION_MARKERS` 决定 seed**：bash 只在 `.env.prod`
 * 存在时保留配置，compose 文件在不在（例如用户为强制重下资产而删掉它）与
 * 「是否覆盖用户配置」无关。旧实现要求两件套齐全才走升级路径，于是「只有
 * `.env.prod`」被误判成空目录首装，`seedEnvFile` 会以 `truncate:true` 覆盖用户
 * 的真实配置 —— 数据销毁（review Finding 1）。现改为只看 `.env.prod` 自身。
 */
async function envFileExists(path: string): Promise<
  "regular" | "exists" | "absent"
> {
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.stat(path);
  } catch {
    st = null;
  }
  if (st === null) return "absent";
  return st.isFile ? "regular" : "exists";
}

/**
 * 目录内是否已有 T9 的任一 Release 资产（决定 `overwrite`，T9 carry-forward）。
 *
 * 与 {@link envFileExists} 刻意分开（两者**互相独立**）：
 * - **是否 seed `.env.prod`** 只看该文件自身是否存在（`envFileExists`）；
 * - **是否覆盖资产** 由 T9 自己的资产清单决定 —— 半成品目录（例如上次安装
 *   中途失败，只留下 compose，或用户为强制重下而删掉 compose）若按"空目录
 *   首装"传 `overwrite:false`，T9 会拒绝覆盖并卡死重试。这里有任一资产就已经
 *   不是"空目录首装"，必须允许覆盖。
 *
 * 反例（review Finding 1 的成因）：若把 `overwrite`/`created` 都挂在 T5 的两件套
 * 标记上，"只有 `.env.prod`、没有 compose"的目录会被判为首装并 truncate 掉用户配置。
 */
async function hasReleaseAssets(dir: string): Promise<boolean> {
  // 判定用**落盘名**（target）：Release 资产叫 env.prod.example，本地叫 .env.prod.example。
  for (const { target } of RELEASE_FILES) {
    if (await isFile(join(dir, target))) return true;
  }
  return false;
}

/**
 * 首次安装缺配置时的可操作报错（复用 T9 `nonInteractiveAdvice` 文案）。
 *
 * `JUDGE_KEYS` **仅在 judge 启用时列出**：judge 关闭（`JUDGE_ENABLED` 为假值）
 * 时那两个键本就不是必需项，一并印出会误导用户去填永远不会被校验的配置。
 *
 * 导出仅为可测：首装路径恒有 `env = {}`（judge 未设置 = 启用），条件分支在
 * `install()` 里不可观测，需要直接单测才能锁住规则（review Minor 2）。
 */
export function missingConfigError(env: EnvValues): Error {
  const advice = nonInteractiveAdvice(false, false);
  const required = judgeEnabledFrom(env)
    ? [...ENV_KEYS.map((spec) => spec.key), ...JUDGE_KEYS]
    : ENV_KEYS.map((spec) => spec.key);
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
 *
 * **安全前提**：调用方必须先确认 `.env.prod` **不存在**。本函数用
 * `truncate:true` 落盘，一旦路径已存在就会销毁既有配置（review Finding 1 的
 * 数据销毁路径），故这里再加一道独立防线：存在即拒绝，绝不静默截断。
 */
async function seedEnvFile(
  envFile: string,
  templateFile: string,
  defaultVersion: string | undefined,
): Promise<void> {
  if ((await envFileExists(envFile)) !== "absent") {
    throw new Error(`生产配置已存在，拒绝覆盖：${envFile}`);
  }
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

// ---------------- install ----------------

/**
 * 真实 cosign 探测：经注入 runner 执行 `cosign version`（无 shell）。
 *
 * 经 {@link probeCommandCode} 归一：cosign **不在 PATH** 时真实 runner 抛
 * `Deno.errors.NotFound`（`Deno.Command` 语义），而 bash 的 `command -v cosign`
 * 只是"未命中"。两处都必须落到同一个 `false`，否则 T12 的 skip-with-warning
 * 契约会被一个裸异常顶替（T15 评审 Important）。
 */
export function probeCosign(
  runner: CommandRunner,
  cosignBin: string,
): () => Promise<boolean> {
  return async () =>
    (await probeCommandCode(runner, cosignBin, ["version"])) === 0;
}

/** 把 compose 输出原样转给调用方（T10 carry-forward：runner 不打印）。 */
function emitComposeOutput(io: PromptIO, result: ComposeResult): void {
  const text = composeOutputText(result);
  if (text !== "") io.write(text);
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

  // ---- 既有 `.env.prod` 是**唯一**的"保留 vs 新建"判据（review Finding 1） ----
  // bash `initialize_env`（:600-615）只要 `-e "$ENV_FILE"` 就保留配置，与 compose
  // 文件是否存在无关；这里逐字对齐，不再用 T5 的 PRODUCTION_MARKERS 两件套判定
  // （那会把"只有 .env.prod"误判为首装并 truncate 覆盖）。
  // T9 carry-forward：overwrite 由 T9 自己的资产清单决定（首次安装 false）。
  const envState = await envFileExists(envFile);
  const created = envState === "absent";
  const overwrite = await hasReleaseAssets(dir);
  if (envState === "exists") {
    throw new Error(`生产配置路径不是普通文件：${envFile}`);
  }

  if (created) {
    // 首次安装：无既有配置可读（.env.prod 尚不存在），非交互不可能补齐配置 →
    // 写盘前明确报错（零写入）。传入空表：judge 未设置 = 启用，故仍会列出
    // JUDGE_KEYS；报错清单按"judge 是否启用"条件化（review Minor 2）。
    const tty = opts.isTty ?? Deno.stdin.isTerminal();
    if (opts.nonInteractive === true || !tty) throw missingConfigError({});
  } else {
    // ---- 既有 `.env.prod`：保留 + chmod 600（bash :602），权限不合格必须
    // 在任何安装动作之前拒绝 ----
    const { mode } = await statMode(envFile);
    const verdict: FilePermissionVerdict = checkEnvFileMode(mode, envFile);
    if (verdict.kind !== "ok") throw new Error(verdict.message);
    // 校验通过后才 chmod 600（bash :602）。放在校验**之后**是有意的：bash 先
    // chmod 再由后续 check_file_permissions 看到 600，等价于把 644 静默修好；本
    // 实现保留 T12 brief 的"权限非 600/400 → 安装前拒绝"语义，只把合法的 400
    // 归一化成 600（与 bash 的最终状态一致）。
    await Deno.chmod(envFile, 0o600);

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
  // 步骤记录必须诚实：只有真的进入并跑完向导才记 `configure`（review Minor 3）。
  let env = await readEnvValues(envFile);
  if (opts.nonInteractive !== true && (opts.isTty ?? Deno.stdin.isTerminal())) {
    if (wizardNeedsInteractiveInput(env)) {
      await runConfigWizard(io, env, { isTty: true, envFile });
      env = await readEnvValues(envFile);
      steps.push({ name: "configure", paths: [envFile] });
    }
  }

  // ---- 4. passphrase（T11）：旗标经 targetFile 注入；仅进程环境抑制回填 ----
  // T16 把该步骤抽成 `ensureCommandPassphrase`（steps.ts），使 install 与 update
  // 走**同一份**装配（路径优先级 / 回填门 / 告警 / 重新读取），不再各写一遍。
  const ensured = await ensureCommandPassphrase({
    envFile,
    env,
    processEnv,
    passphraseFile: opts.passphraseFile,
    warn,
  });
  if (ensured.error !== null) throw new Error(ensured.error);
  env = ensured.env;
  steps.push({ name: "passphrase", paths: [ensured.path] });

  // ---- 5. validate：与四个生命周期命令共用 prepareAndCheck（T13 评审 Important）----
  // bash 的 check_configuration 六步在此**与 start/stop/status/restart 逐条同源**：
  // 1 env 文件 → 2 权限 → 3 check_required_values → 4 check_judge_socket →
  // 5 check_port_value → 6 compose config。此前 install 只共享 1/2/3，另三步在
  // 本文件各写一份（judge socket、compose config 重复），正是评审指出的分叉。
  // 失败文案与 bash `fail` 逐字一致（compose 无效时仍带 stderr 细节）。
  const prepared = await prepareAndCheck({
    dir,
    runner,
    socketExists: opts.socketExists,
  });
  if (!prepared.ok) throw new Error(prepared.error);
  // P1a：与 upgrade 共用同一个「已解析目标发布配置」（验签与 pull/up 同源）。
  const plan = await resolveTargetConfig(prepared);
  if (!plan.ok) throw new Error(plan.error);
  const target = plan.target;
  steps.push({ name: "validate", paths: [envFile, composeFile] });

  // ---- 6. verify-images（T11）：cosign 缺失/失败必须可见 ----
  const verify = await verifyImageSignatures(target.env, {
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
  const pulled = await runComposeSub(runner, target.composeOptions, ["pull"]);
  emitComposeOutput(io, pulled);
  if (!Array.isArray(pulled) && pulled.code !== 0) {
    throw new Error(
      "拉取生产镜像失败：" +
        (pulled.stderr.trim() || ("docker compose 退出码 " + pulled.code)),
    );
  }
  steps.push({ name: "compose-pull", paths: [composeFile] });

  // wait_for_stack（deploy.sh:981-993）与 start 共用同一份实现：T12 只跑
  // `up -d --wait`，缺 `--wait-timeout 180 --remove-orphans` 与第二段 nginx
  // 刷新；本任务（T13）补齐，install 因此获得与 bash 逐字一致的两段编排。
  const wait = await waitForStack(
    runner,
    target.composeOptions,
    (text) => io.write(text),
  );
  if (!wait.ok) throw new Error(wait.error ?? "服务启动或健康检查失败");
  const composeUpCode = wait.code;
  steps.push({ name: "compose-up", paths: [composeFile] });

  // ---- 8. record-metadata（T11）：无验签结果时零副作用 ----
  // T4 状态：`install` **仍然有意不查** `compose ps`（与 bash `install()` 一致），
  // 但 T12 的"延后到 T13"已在本任务闭合：T4 状态机由 `status`/`start`/`stop`
  // 消费（见模块头「T13：T4 状态机的落点」）。安装用 `waitForStack` 的退出码表达
  // "是否真的起来"，不额外查询；下一次 `status` 即可从 `compose ps` 读出真实态。
  const metadata = await recordDeploymentMetadata({
    version: target.version,
    at: opts.now ?? new Date(),
    verified: verify.digests,
    backupDir: join(dir, "backups"),
  });
  steps.push({
    name: "record-metadata",
    paths: metadata.path === null ? [] : [metadata.path],
  });

  // ---- 8.5 安装二进制（`install.sh:558-565` 的 `install_cli()`）----
  // 必须在 register 之前：`registerCommand` 见目标不存在就按"源码运行模式"
  // 跳过注册，于是"安装成功"却没有任何可执行入口（评审发现的 R4 阻塞）。
  // 用 try/catch 而非静默：写不进 `<dir>/bin` 属真实失败，但**不**应让整个
  // 安装失败——docker 栈已经起来了，报错并继续才是可操作的（与 bash 的
  // `install_cli` 失败即 `fail` 不同：bash 那时目录还没起栈）。
  let installedBinary: string | null = null;
  try {
    installedBinary = await installCliBinary({
      dir,
      executable: opts.executable,
    });
    if (installedBinary !== null) {
      steps.push({ name: "install-cli", paths: [installedBinary] });
    }
  } catch (err) {
    warn(
      `未能把 CLI 安装到 ${join(dir, "bin/noj-cli")}：${
        (err as Error).message
      }；可手动复制后重试注册`,
    );
  }

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

// ---------------- start / stop / restart / status（T13）----------------

/**
 * 生命周期命令的公共选项。
 *
 * 与 {@link InstallOptions} 一样，**一切外部访问都可注入**：命令走 `runner`、
 * 输出走 T6/T8 的 {@link RenderIO}、目录由 `dir` 给出。测试因此不触真实 docker、
 * 不写真实 stdout/stderr。
 */
