/**
 * 生产生命周期命令入口（T12 起）：install / start / stop / restart / status。
 *
 * 结构（T13 拆分）：**命令入口与结果形状留在本文件**。两个内聚单元已外移：
 * - `./lifecycle/steps.ts`：被多个动作共享的 compose 编排（`waitForStack`）与
 *   前置校验（`prepareAndCheck`，即 bash `check_configuration` 六步），
 *   T14–T16 的编排增量进该模块；
 * - `./lifecycle/path.ts`：仅服务 install 第 9 步的 PATH 注册
 *   （`registerCommand`/`PATH_LINE`，production.sh `register_command`）。
 *
 * 两者都是「命令无关」的单元，因此本文件只留命令入口、结果形状与上下文装配。
 *
 * ## T13：T4 状态机的落点（T12 的 carry-forward 在本任务闭合）
 *
 * T12 的 `install` **有意不查** `docker compose ps`（与 bash `install()` 一致），
 * 状态落盘延后到本任务，已登记在 task-12 报告的「有意非迁移清单」与
 * `install()` 第 8 步前的注释。本任务把 T4 状态机真正接上，四个命令的消费方式：
 *
 * | 命令 | 如何消费 T4 |
 * | --- | --- |
 * | `status` | `prodState(compose ps 的输出)` 推断 running / partial / stopped |
 * | `start` | 先 `prodState` 推断当前态；`upIsNoOp(当前态)` 为真即 **no-op**（不跑 `up`），否则 `waitForStack` |
 * | `stop` | 先 `prodState` 推断当前态；`downIsNoOp(当前态)` 为真即 **no-op**（不跑 `stop`），否则 `compose stop` |
 * | `restart` | T4 `transition(当前态, "restart")` 表达目标态 running；实际执行为 stop → start，顺序对齐 bash `deploy.sh:1034-1044` 与 `production.sh:437-441` |
 *
 * **no-op 文案逐字取自 T4**（`upIsNoOp`/`downIsNoOp` 背后的
 * `transition(...).message`：`已处于 running，无需重复启动` /
 * `已处于 stopped，无需重复关闭`），本模块不另写第二份提示语。
 *
 * ## 退出码（#517 E9 的 0/1/2 项目契约）
 *
 * 四个命令都返回 `exitCode`：0 成功（含 no-op）；1 运行失败（前置校验不过、
 * compose 失败、wait_for_stack 失败）。**用法错误（未知旗标等）= 2 由 CLI 解析层
 * 产出**（`cli.ts` + `util/args.ts:UsageError`），命令层不吞不掉、也不自行判 2。
 *
 * ## 与 bash 的有意差异（R3 逐项核对后保留）
 *
 * 1. **`--dry-run` 未迁移**：bash `run_compose` 有 DRY_RUN 早退；本模块的 dryRun
 *    只存在于 T10 封装（`ComposeOptions.dryRun`），四个命令不暴露该旗标
 *    （brief 未要求，且 T16 才需要脚本化干跑）。
 * 2. **`check_dependencies` 的 docker / daemon / buildx 三条未接线**：
 *    `prepareAndCheck` 已迁移 `check_configuration` 六步 + `check_dependencies`
 *    的 compose 文件判定；只有「docker 可执行 / daemon 可连 / buildx 可用」
 *    这三条环境探测仍属环境面（T12 报告 §6.4 已登记），compose 调用失败会自然
 *    报错。**步骤 5 的 `lsof` 占用探测**经 `LifecycleOptions.probePort` 可注入，
 *    未注入即等同 bash 的 `command -v lsof` 不命中（只 warn，不 fail）。
 * 3. **`stop` 失败仍报成功**：bash `stop()` 不看 `compose stop` 的退出码就
 *    `ok "服务已停止，数据卷已保留"`。本实现如实读退出码（!=0 → 退出码 1），
 *    因为"静默假装成功"是真实可用性缺口；文案差异已在测试中显式断言。
 * 4. **人类输出走注入的 RenderIO**：bash 直写终端；本模块经 T8 `renderTable` /
 *    T6 `emitHuman`，`--json` 时人类文字自动改道 stderr（R5）。
 *
 * 以下 `install` 的章节保留 T12 原文（为可追溯，未随本次拆分改写）。
 *
 * ---
 *
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
 * 2. **seed-env**（仅当 `.env.prod` **不存在**）：由模板生成 `.env.prod`（600）
 *    并写入自动生成的强随机密钥（deploy.sh :622-644）；既有文件逐字节保留；
 * 3. **configure**（仅在仍有缺失时执行并记录）：T11 {@link runConfigWizard}
 *    交互向导（仅 TTY；非交互缺配置直接报错且**零写入**）；
 * 4. **passphrase**：T11 {@link ensureBackupPassphrase}（deploy.sh :920-953）；
 * 5. **validate**：与四个生命周期命令**共用** `lifecycle/steps.ts:prepareAndCheck`
 *    ——bash `check_configuration` 六步（env 文件 / 权限 / 必填值 / judge socket /
 *    端口 / `compose config`，deploy.sh :893-914 + :684-789）；
 * 6. **verify-images**：T11 {@link verifyImageSignatures}（deploy.sh :837-874）；
 * 7. **compose-pull / compose-up**：T10 {@link composeUp} 等（deploy.sh
 *    `run_compose pull` + `wait_for_stack` :981-992）；
 * 8. **record-metadata**：T11 {@link recordDeploymentMetadata}（deploy.sh :875-891）；
 * 9. **register**：PATH 注册（production.sh:97-131 的 `register_command`）。
 *
 * ## 上游 CARRY-FORWARD（全部落实）
 *
 * 1. **T9**：`downloadReleaseFiles` 的 `overwrite` 默认 false（拒绝覆盖）→
 *    目录里**已有任一 Release 资产**（`docker-compose.prod.yml` 或
 *    `.env.prod.example`）时显式传 `overwrite:true`，真正的空目录首装才保持
 *    false。**注意**：`overwrite` **不是**由 `.env.prod` 是否存在决定的，它只
 *    看 T9 自己的 `RELEASE_FILES` 资产清单（{@link hasReleaseAssets}）。
 *    **是否 seed `.env.prod`** 是另一条**独立**判定：只看该文件自身是否存在，
 *    {@link seedEnvFile} 绝不覆盖已存在的 `.env.prod`（对照 bash
 *    `initialize_env` :600-615 的 `[[ -e "$ENV_FILE" ]]` 早退）。T5 的
 *    `PRODUCTION_MARKERS`（compose + env 两件套）不再是 install 的判定依据，
 *    它只由 `production.ts` 的 profile 探测消费。资产名沿用 T9 的
 *    `RELEASE_FILES`（各带 `.sha256`）。
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
 * - ~~**`wait_for_stack` 的附加旗标**~~：**T13 已闭合**——`install` 与 `start`
 *   现共用 `lifecycle/steps.ts:waitForStack`，逐字跑
 *   `up -d --wait --wait-timeout 180 --remove-orphans` 与
 *   `up -d --force-recreate --no-deps nginx`（对照 deploy.sh:987-990）。
 * - **不把运行中的二进制复制进 `<dir>/bin/noj-cli`**：那是 install.sh
 *   `download_cli`/`install_cli` 的职责，随 R4 删除；二进制由用户手动下载
 *   （R4），跨版本同步归 T16。PATH 注册（`./lifecycle/path.ts`）严格照
 *   `register_command` 语义：目标不存在时按「源码运行模式」告警并跳过。
 * - **`composeUpCode` 如实取自 `waitForStack`**：bash `wait_for_stack` 失败即
 *   `fail` 退出，故 `install` 返回时该值恒为真 0（不再硬编码）。
 * - **不落 T4 状态**：`install` 不查 `compose ps`（与 bash `install()` 一致，
 *   用 `waitForStack` 的退出码表达"是否真的起来"）。T12 曾把 brief 的「落状态
 *   （T4）」**延后到 T13**；**T13 已闭合**：`status`/`start`/`stop` 消费 T4 的
 *   `prodState`/`transition`（见本模块头）。
 */

import { join } from "@std/path";
import {
  checkEnvFileMode,
  ENV_KEYS,
  JUDGE_KEYS,
} from "../core/config-schema.ts";
import type { FilePermissionVerdict } from "../core/config-schema.ts";
import { writeEnvFileAtomic } from "../core/env-file.ts";
import { downIsNoOp, prodState, transition, upIsNoOp } from "../core/state.ts";
import type { DeployState } from "../config/types.ts";
import { randomKey } from "../init/secrets.ts";
import { nonInteractiveAdvice } from "../init/non_interactive.ts";
import {
  emitHuman,
  emitJson,
  isJsonMode,
  renderStatus,
} from "../output/render.ts";
import type { RenderIO } from "../output/render.ts";
import { createTheme } from "../output/theme.ts";
import type { StatusKind } from "../output/theme.ts";
import type { CommandRunner } from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import type { ColorMode } from "../util/color.ts";
import {
  downloadReleaseFiles,
  RELEASE_FILES,
  validateTargetDir,
} from "./bootstrap.ts";
import type { Fetcher } from "./bootstrap.ts";
import { composeLogs, composePs } from "./compose.ts";
import type { ComposeOptions, ComposeResult } from "./compose.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "./compose.ts";
import {
  backupPassphrasePath,
  ensureBackupPassphrase,
  generateSecret,
  recordDeploymentMetadata,
  runConfigWizard,
  toEntries,
  verifyImageSignatures,
  wizardNeedsInteractiveInput,
} from "./config.ts";
import type { EnvValues, VerifiedDigest } from "./config.ts";
import {
  applyLogsColor,
  assertConfiguration,
  composeOutputText,
  decideLogsColor,
  isFile,
  judgeEnabledFrom,
  mergeColorSource,
  prepareAndCheck,
  readEnvValues,
  runComposeSub,
  statMode,
  WAIT_FAILURE_HINT,
  waitForStack,
} from "./lifecycle/steps.ts";
import type { LogsColorDecision } from "./lifecycle/steps.ts";
import { registerCommand } from "./lifecycle/path.ts";
import type { PathRegistration } from "./lifecycle/path.ts";
import type { PreparedEnvironment } from "./lifecycle/steps.ts";

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

// ---------------- 通用小工具 ----------------

// 通用小工具（readEnvValues / isFile / statMode）已抽到 ./lifecycle/steps.ts，
// 由本模块与 start/stop/restart/status 共用（T13 拆分，避免同形函数两份）。

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
 * 反例（review Finding 1 的成因）：若把 `overwrite`/`created` 都挂在 T5 的
 * 两件套标记上，"只有 `.env.prod`、没有 compose"的目录会被判为首装，
 * `seedEnvFile` 随即 truncate 掉用户的真实配置。
 */
async function hasReleaseAssets(dir: string): Promise<boolean> {
  for (const asset of RELEASE_FILES) {
    if (await isFile(join(dir, asset))) return true;
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

/** 真实 cosign 探测：经注入 runner 执行 `cosign version`（无 shell）。 */
function probeCosign(
  runner: CommandRunner,
  cosignBin: string,
): () => Promise<boolean> {
  return async () => (await runner.run(cosignBin, ["version"])).code === 0;
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
  const composeOptions: ComposeOptions = composeOptionsOf(prepared);
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

  // wait_for_stack（deploy.sh:981-993）与 start 共用同一份实现：T12 只跑
  // `up -d --wait`，缺 `--wait-timeout 180 --remove-orphans` 与第二段 nginx
  // 刷新；本任务（T13）补齐，install 因此获得与 bash 逐字一致的两段编排。
  const wait = await waitForStack(
    runner,
    composeOptions,
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

// ---------------- start / stop / restart / status（T13）----------------

/**
 * 生命周期命令的公共选项。
 *
 * 与 {@link InstallOptions} 一样，**一切外部访问都可注入**：命令走 `runner`、
 * 输出走 T6/T8 的 {@link RenderIO}、目录由 `dir` 给出。测试因此不触真实 docker、
 * 不写真实 stdout/stderr。
 */
export interface LifecycleOptions {
  /** 生产安装目录（`--dir`）；入口负责归一化（T9 `validateTargetDir`）。 */
  dir: string;
  /** 外部命令注入点（docker）。 */
  runner: CommandRunner;
  /** 人类可读输出汇聚点；缺省直达真实进程流。 */
  io?: RenderIO;
  /** 原始参数：仅用于 `isJsonMode` 判定 `--json`（缺省视为人类模式）。 */
  args?: string[];
  /** 着色模式（`--color`）；缺省 `auto`（非 TTY 自动关色）。 */
  color?: ColorMode;
  /**
   * judge socket 存在性探测（T11 `checkJudgeSocket` 的注入点）。
   *
   * 仅 judge 启用时被调用；缺省不探测 = bash judge 关闭时的「已跳过」分支。
   */
  socketExists?: (path: string) => Promise<boolean>;
  /**
   * 端口占用探测（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 的注入点）。
   *
   * 缺省不探测（等同 bash `command -v lsof` 不命中）；注入后命中即写一条
   * 端口冲突告警，**不阻断**命令（与 bash 的 `warn` 一致）。
   */
  probePort?: (port: number) => Promise<boolean>;
}

/** 四个生命周期命令的公共结果形状。 */
export interface LifecycleBaseResult {
  /** 归一化安装目录（无尾斜杠）。 */
  dir: string;
  /** T4 状态机给出的当前/最终状态。 */
  state: DeployState;
  /** 是否 no-op（未执行任何变更命令）。 */
  noOp: boolean;
  /** 进程退出码：0 成功（含 no-op）/ 1 运行失败；用法错误 2 由 CLI 层产出。 */
  exitCode: number;
  /** 运行失败的面向用户文案；成功为 null。 */
  error: string | null;
}

/** {@link status} 的结果。 */
export interface StatusResult extends LifecycleBaseResult {
  /** `docker compose ps` 的原始 stdout（`status --json` 的机器可读通道）。 */
  psOutput: string;
}

/** 一次命令运行的上下文：目录 + 两个输出通道 + 状态行写出器。 */
interface LifecycleContext {
  dir: string;
  io: RenderIO;
  jsonMode: boolean;
  /** 写一行状态（T8 符号 + 语义色），JSON 模式自动改道 stderr。 */
  status: (kind: StatusKind, text: string) => void;
  /** 写一条失败诊断：**永远 stderr**（对照 bash `fail` 的 >&2）。 */
  error: (text: string) => void;
}

/** 真实 stderr 写入（RenderIO 未注入 stderr 时的兜底）。 */
function realStderr(text: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(text));
}

/**
 * 写失败诊断到 stderr。
 *
 * bash `fail` 是 `printf ... >&2; exit 1`，而 T6 的 `emitHuman` 在人类模式写
 * **stdout**（只有 JSON 模式改道 stderr）——两者不能同时满足，故失败诊断显式
 * 走 stderr：这样重定向 `> out.txt` 时错误仍可见，`--json` 的 stdout 也不被污染。
 */
function emitFailure(io: RenderIO, text: string): void {
  (io.stderr ?? realStderr)(text);
}

/** 构造命令上下文：T6 的 JSON 模式与 T8 的 stream 成对判定。 */
function lifecycleContext(opts: LifecycleOptions): LifecycleContext {
  const jsonMode = isJsonMode(opts.args ?? []);
  const io: RenderIO = { ...(opts.io ?? {}), jsonMode };
  const stream = jsonMode ? "stderr" : "stdout";
  const theme = createTheme(opts.color ?? "auto", stream);
  return {
    dir: validateTargetDir(opts.dir),
    io,
    jsonMode,
    status: (kind, text) => {
      renderStatus(kind, text, { color: opts.color, stream, io });
    },
    error: (text) => emitFailure(io, theme.status("error", text) + "\n"),
  };
}

/** 由已校验的环境构造 T10 compose 选项（judge → `--profile judge`）。 */
function composeOptionsOf(env: PreparedEnvironment): ComposeOptions {
  return {
    composeFile: env.composeFile,
    envFile: env.envFile,
    judge: env.judge,
  };
}

/**
 * `prepare_and_check` 的公共前置：配置校验（T13 评审 Important：与 install 同源）。
 *
 * `prepareAndCheck` 负责 bash `check_configuration` 的**六步**（env 文件 / 权限 /
 * 必填值 / judge socket / 端口 / compose config），本函数只把它接进命令上下文：
 * 1. 目录经 `validateTargetDir` 归一化（`lifecycleContext` 已做）；
 * 2. 环境探测注入点从 {@link LifecycleOptions} 透传（未注入即 bash 的「已跳过」/「无 lsof」）；
 * 3. 端口冲突告警走人类通道（T6/T8，`--json` 自动改道 stderr）；
 * 4. 失败诊断写 stderr 并回传文案。
 *
 * **零变更命令**：步骤 1–5 不调用 docker；步骤 6 的 `compose config` 只读解析。
 * 任一失败都发生在任何 `up`/`stop`/`down` 之前。
 */
async function prepareLifecycle(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<
  | { ok: true; composeOptions: ComposeOptions; env: EnvValues }
  | { ok: false; error: string }
> {
  const prepared = await prepareAndCheck({
    dir: ctx.dir,
    runner: opts.runner,
    socketExists: opts.socketExists,
    probePort: opts.probePort,
    write: (text) => emitHuman(text + "\n", ctx.io),
  });
  if (!prepared.ok) {
    ctx.error(prepared.error);
    return { ok: false, error: prepared.error };
  }
  ctx.status("success", "生产配置检查通过");
  // env 透传给 logs（T14）：着色取值需要读 .env.prod 的 LOG_COLOR / NO_COLOR，
  // 复用已读取的同一份值，避免在命令层再解析一遍配置文件。
  return {
    ok: true,
    composeOptions: composeOptionsOf(prepared),
    env: prepared.env,
  };
}

/** 取“当前真实状态”：跑 `docker compose ps` 并用 T4 `prodState` 推断。 */
async function probeState(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
  options: ComposeOptions,
): Promise<
  | { ok: true; state: DeployState; psOutput: string }
  | { ok: false; error: string }
> {
  const result = await composePs(opts.runner, options);
  if (Array.isArray(result)) {
    // dryRun：没有真实输出可解析；属调用方误用，按运行失败处理。
    const error = "compose ps 未真实执行（dryRun）";
    ctx.error(error);
    return { ok: false, error };
  }
  // compose 的告警写在 stderr（可能混有 WARN 行）：原样转 stderr，不静默丢弃。
  if (result.stderr !== "") emitFailure(ctx.io, result.stderr);
  if (result.code !== 0) {
    const error = "docker compose ps 失败：" + result.stderr.trim();
    ctx.error(error);
    return { ok: false, error };
  }
  return { ok: true, state: prodState(result.stdout), psOutput: result.stdout };
}

/** T4 状态 → T8 状态符号种类 + 中文标签（人类可读摘要行）。 */
function stateLabel(state: DeployState): { kind: StatusKind; text: string } {
  switch (state) {
    case "running":
      return { kind: "success", text: "生产服务运行中（running）" };
    case "partial":
      return { kind: "warning", text: "生产服务部分运行（partial）" };
    case "stopped":
      return { kind: "info", text: "生产服务未运行（stopped）" };
    case "uninitialized":
      return { kind: "info", text: "生产服务未初始化（uninitialized）" };
    case "error":
      return { kind: "error", text: "生产服务处于错误状态（error）" };
  }
}

// ---------------- logs（T14，deploy.sh:1117-1158） ----------------

/**
 * logs 的选项：在 {@link LifecycleOptions} 上追加服务名、--follow 与着色取值来源。
 *
 * 命名为 LogsCommandOptions（而非 LogsOptions）：后者已被 maintain/logs.ts 的
 * JSON 编排日志命令占用，包入口（mod.ts）再导出会撞名。
 *
 * LOG_COLOR / NO_COLOR 的**取值**统一经 {@link LogsCommandOptions.env}（缺省读进程环境）
 * 与 .env.prod；命令层只做合并，开/关判定交回 resolveColor（见
 * lifecycle/steps.ts 的 decideLogsColor），不新造第二套解析。
 */
export interface LogsCommandOptions extends LifecycleOptions {
  /** 位置参数（服务名）；透传给 compose。缺省 = 所有服务。 */
  services?: string[];
  /** 是否 --follow（实时跟随）。 */
  follow?: boolean;
  /**
   * 进程环境快照；缺省 Deno.env.toObject()（与 install 的 processEnv 同义）。
   *
   * 只为可测：断言里不必污染真实进程环境，也便于模拟「进程 env > .env.prod」。
   */
  env?: Record<string, string>;
}

/**
 * logs 的结果：在公共形状上追加服务名、着色决策与是否跟随。
 *
 * `state` 恒为 `"running"` 且**不作探测**（与 bash `logs()` 一致：不查
 * `compose ps`）；它只是为满足 {@link LifecycleBaseResult} 的公共形状，
 * **不代表真实栈状态**。
 */
export interface LogsResult extends LifecycleBaseResult {
  /** 透传的服务名（与输入一致）。 */
  services: string[];
  /**
   * 最终**着色决策**：`force` / `inherit` / `no-color`。
   *
   * 命名刻意不叫 `color`——它不是 {@link ColorMode}
   * （`auto`/`always`/`never`），而是 `applyLogsColor` 落回 compose 参数的
   * 三态结论，也是 `--json` 载荷的一部分，便于测试断言。
   */
  colorDecision: LogsColorDecision;
  /** 是否走实时跟随路径。 */
  followed: boolean;
}

/**
 * logs（deploy.sh:1117-1158）：前置校验 → 着色判定 → compose logs。
 *
 * 迁移要点：
 * 1. **着色优先级**逐字对照 bash（见 steps.ts 的 decideLogsColor）：NO_COLOR 非空
 *    或 LOG_COLOR=never → --no-color；LOG_COLOR=always → 强制（子命令**之前**的
 *    全局 --ansi always）；否则按 stdout 是否 TTY（resolveColor）。取值
 *    **进程环境优先、回退 .env.prod**；
 * 2. **实时跟随走 CommandRunner.stream**：T10 composeLogs 经 run() 是**缓冲**的，
 *    --follow 会一直不返回、看不到输出（T10/T13 已登记）。因此 follow 分支先用
 *    T10 的 composeLogs(dryRun: true) 取参数数组，再交给 stream 逐行写 stdout；
 * 3. **非 follow 用缓冲路径并自行写 stdout**（runner 不替调用方打印，T10
 *    carry-forward）：stdout 原样写人类通道、stderr（compose 告警）原样转 stderr；
 * 4. **--json 纯净**：stdout 只有结果 JSON，日志与诊断都改道 stderr（T6/T13 先例）；
 * 5. **退出码**：0 成功 / 1 运行失败（前置校验不过、compose 非 0）；用法错误 2 由
 *    CLI 解析层产出。
 */
export async function logs(opts: LogsCommandOptions): Promise<LogsResult> {
  const ctx = lifecycleContext(opts);
  const services = opts.services ?? [];
  const followed = opts.follow === true;

  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    const result: LogsResult = {
      ...failed(ctx.dir, prepared.error),
      services,
      colorDecision: "no-color",
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }

  // ---- 着色判定：进程环境优先，回退 .env.prod；开/关交回 resolveColor ----
  const processEnv = opts.env ?? Deno.env.toObject();
  const decision = decideLogsColor({
    logColor: mergeColorSource(
      processEnv["LOG_COLOR"],
      prepared.env["LOG_COLOR"],
    ),
    noColor: mergeColorSource(processEnv["NO_COLOR"], prepared.env["NO_COLOR"]),
    // bash 用 [[ -t 1 ]] 探测 **stdout**；这里保持同一流。
    stream: "stdout",
  });

  const logOptions = { ...prepared.composeOptions, services, follow: followed };
  // dryRun 只取参数数组：参数形状由 T10 唯一保证，着色两处插入由 T14 helper 完成。
  const dryRun = await composeLogs(opts.runner, {
    ...logOptions,
    dryRun: true,
  });
  if (!Array.isArray(dryRun)) {
    const error = "compose logs 参数构造失败（dryRun 未返回参数数组）";
    ctx.error(error);
    const result: LogsResult = {
      ...failed(ctx.dir, error),
      services,
      colorDecision: decision,
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }
  const args = applyLogsColor(dryRun, decision);

  const code = followed
    ? await streamLogs(opts.runner, args, ctx)
    : await runLogs(opts.runner, args, ctx);
  if (code !== 0) {
    const error = "查看生产服务日志失败（docker compose 退出码 " + code + "）";
    ctx.error(error);
    const result: LogsResult = {
      ...failed(ctx.dir, error),
      services,
      colorDecision: decision,
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }

  const result: LogsResult = {
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
    services,
    colorDecision: decision,
    followed,
  };
  // JSON 模式：stdout 只含这一个文档；日志本体与诊断已改道 stderr（emitHuman）。
  if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
  return result;
}

/** logs 的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */
function logsPayload(result: LogsResult): Record<string, unknown> {
  return {
    dir: result.dir,
    services: result.services,
    colorDecision: result.colorDecision,
    followed: result.followed,
    error: result.error,
  };
}

/** 非 follow：缓冲执行并**自行**写出（runner 不打印）。 */
async function runLogs(
  runner: CommandRunner,
  args: string[],
  ctx: LifecycleContext,
): Promise<number> {
  const result = await runner.run("docker", args);
  // 日志本体是人类通道输出（--json 时自动改道 stderr），告警（compose stderr）
  // 同样改道——stdout 在 JSON 模式下必须逐字节为 JSON。
  emitHuman(result.stdout, ctx.io);
  // compose 告警属于诊断：**永远 stderr**（对照 bash 的 >&2 继承），
  // 这样重定向 stdout 时告警仍可见、--json 的 stdout 也不被污染。
  if (result.stderr !== "") emitFailure(ctx.io, result.stderr);
  return result.code;
}

/**
 * follow：实时逐行执行（T13 报告的缺口在本任务闭合）。
 *
 * runner 未实现 stream（P2 既有 fake）时**不静默降级**：直接报错，避免
 * --follow 悄悄退化成不可用的缓冲调用。
 */
async function streamLogs(
  runner: CommandRunner,
  args: string[],
  ctx: LifecycleContext,
): Promise<number> {
  if (runner.stream === undefined) {
    ctx.error("当前运行时不支持实时日志（CommandRunner.stream 缺失）");
    return 1;
  }
  return await runner.stream("docker", args, (line) => {
    emitHuman(line + "\n", ctx.io);
  });
}

/** 生命周期结果的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */
function jsonPayload(result: LifecycleBaseResult): Record<string, unknown> {
  return {
    dir: result.dir,
    state: result.state,
    noOp: result.noOp,
    error: result.error,
  };
}

/** 统一的运行失败结果（`error` 已写往人类通道）。 */
function failed(dir: string, error: string): LifecycleBaseResult {
  return { dir, state: "error", noOp: false, exitCode: 1, error };
}

/**
 * `status`（deploy.sh:1112-1115）：`prepare_and_check` → `run_compose ps`。
 *
 * **T4 接线点**：`prodState(compose ps 的输出)` 推断 running / partial / stopped。
 * 状态**探测成功本身**即退出码 0（与 bash 一致：`compose ps` 成功就是成功，
 * 不因栈处于 stopped 而失败）；只有前置校验或 `compose ps` 失败才是 1。
 *
 * 人类输出 = 状态摘要行（T8） + 完整 compose 表（含原表头，与 bash 一致）；
 * `--json` 时 stdout 只有 `{ dir, state, ps }` 一个 JSON 文档，人类文字改道 stderr。
 */
export async function status(opts: LifecycleOptions): Promise<StatusResult> {
  const ctx = lifecycleContext(opts);
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    if (ctx.jsonMode) {
      emitJson({
        dir: ctx.dir,
        state: "uninitialized",
        ps: "",
        error: prepared.error,
      }, ctx.io);
    }
    return {
      ...failed(ctx.dir, prepared.error),
      state: "uninitialized",
      psOutput: "",
    };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) {
    if (ctx.jsonMode) {
      emitJson(
        { dir: ctx.dir, state: "error", ps: "", error: probe.error },
        ctx.io,
      );
    }
    return { ...failed(ctx.dir, probe.error), psOutput: "" };
  }

  if (ctx.jsonMode) {
    emitJson({ dir: ctx.dir, state: probe.state, ps: probe.psOutput }, ctx.io);
  }
  const label = stateLabel(probe.state);
  ctx.status(label.kind, label.text);
  if (probe.psOutput !== "") emitHuman(probe.psOutput, ctx.io);

  return {
    dir: ctx.dir,
    state: probe.state,
    noOp: false,
    exitCode: 0,
    error: null,
    psOutput: probe.psOutput,
  };
}

/** `start` 的核心（不写 JSON；由公开入口按模式补写）。 */
async function startWith(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    return { ...failed(ctx.dir, prepared.error), state: "uninitialized" };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) return failed(ctx.dir, probe.error);

  // T4：running 时 up 是 no-op（changed=false）→ 不重复启动。
  const decision = transition(probe.state, "up");
  if (upIsNoOp(probe.state)) {
    ctx.status("success", decision.message);
    return {
      dir: ctx.dir,
      state: decision.state,
      noOp: true,
      exitCode: 0,
      error: null,
    };
  }

  const wait = await waitForStack(
    opts.runner,
    prepared.composeOptions,
    (text) => emitHuman(text, ctx.io),
  );
  if (!wait.ok) {
    const error = wait.error ?? WAIT_FAILURE_HINT;
    ctx.error(error);
    return failed(ctx.dir, error);
  }

  ctx.status("success", "生产服务已启动");
  return {
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
  };
}

/** `stop` 的核心（不写 JSON；由公开入口按模式补写）。 */
async function stopWith(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    return { ...failed(ctx.dir, prepared.error), state: "uninitialized" };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) return failed(ctx.dir, probe.error);

  // T4：stopped 时 down 是 no-op（changed=false）→ 不重复关闭。
  const decision = transition(probe.state, "down");
  if (downIsNoOp(probe.state)) {
    ctx.status("success", decision.message);
    return {
      dir: ctx.dir,
      state: decision.state,
      noOp: true,
      exitCode: 0,
      error: null,
    };
  }

  ctx.status("info", "停止生产服务");
  // 裸 `stop` 子命令（T10 无命名封装）——绝不含 down/-v，数据卷保留。
  const stopped = await runComposeSub(opts.runner, prepared.composeOptions, [
    "stop",
  ]);
  const text = composeOutputText(stopped);
  if (text !== "") emitHuman(text, ctx.io);
  if (!Array.isArray(stopped) && stopped.code !== 0) {
    const error = "停止生产服务失败，请执行 status 和 logs 排查";
    ctx.error(error);
    return failed(ctx.dir, error);
  }

  ctx.status("success", "服务已停止，数据卷已保留");
  return {
    dir: ctx.dir,
    state: "stopped",
    noOp: false,
    exitCode: 0,
    error: null,
  };
}

/**
 * `start`（deploy.sh:1027-1032）：`prepare_and_check` → `wait_for_stack`。
 *
 * **T4 接线点**：先探测当前态，`upIsNoOp(当前态)` 为真即 **no-op**，绝不重复
 * 执行 `compose up`（bash 会无条件重跑 up；本实现按 brief 的“已 running 时
 * no-op”要求收紧）。no-op 文案逐字取自 T4 `transition(..., "up").message`。
 */
export async function start(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const result = await startWith(ctx, opts);
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}

/**
 * `stop`（deploy.sh:1045-1050）：`prepare_and_check` → `run_compose stop`。
 *
 * **绝不使用 `down`/`-v`/`--volumes`**：bash 明写“服务已停止，数据卷已保留”。
 * **T4 接线点**：`downIsNoOp(当前态)` 为真即 **no-op**（已 stopped 不再 stop），
 * no-op 文案逐字取自 T4 `transition(..., "down").message`。
 */
export async function stop(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const result = await stopWith(ctx, opts);
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}

/**
 * `restart`：**先 stop 再 start**（production.sh:437-441 的逐字顺序）。
 *
 * **T4 接线点**：`transition(最终态, "restart")` 表达目标态 running（changed 恒
 * 为 true，restart 从不停用）；实际编排复用 `stop` → `start`，因此中间态、
 * no-op 判定与错误传播都与两命令各自独立时一致。
 *
 * 顺序断言（测试锁定）：`stop` 的 compose 调用严格早于 `up`。JSON 模式只在
 * 最后输出**一个**文档（内部两步不各自写 stdout），stdout 因此逐字节合法。
 */
export async function restart(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const stopped = await stopWith(ctx, opts);
  if (stopped.exitCode !== 0) {
    if (ctx.jsonMode) emitJson(jsonPayload(stopped), ctx.io);
    return stopped;
  }
  const started = await startWith(ctx, opts);
  const target = transition(started.state, "restart");
  const result: LifecycleBaseResult = {
    ...started,
    state: started.exitCode === 0 ? target.state : "error",
  };
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}
