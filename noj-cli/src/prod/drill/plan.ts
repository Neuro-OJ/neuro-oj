/**
 * 演练的参数校验、隔离编排规划与资源前置（T19）。
 *
 * 迁移 `scripts/deploy/restore-drill.sh` 的 `preflight()`（:250-281）、
 * `prepare_directories()`（:282-306）、`prepare_compose_override()`（:321-339）与
 * `env_value()`/`file_mode()`/`check_secret_file()`（:98-121）；参数校验部分
 * **复用** `maintain/drill.ts` 已带 P1/P2 评审修复的实现（见下方 import 说明）。
 *
 * ## 为什么这些是纯函数 / 可注入
 *
 * `restore-drill.sh` 的等价逻辑散在 609 行里、与 docker 调用交织，因此无法单测
 * "参数错误是否在起容器之前被拦下"。本模块把**判定**与**执行**分开：
 * - 判定（项目名 / 子网 / RPO-RTO / 快照形态 / 覆盖 YAML 生成）全为纯函数；
 * - 执行（docker 调用）只在 `drill.ts` 的编排层，且一切经注入的 runner。
 *
 * 于是"资源/参数错误 = 退出码 2 且**零 compose 调用**"成为可断言的性质。
 *
 * ## 隔离性的三条硬保证（#516 核心）
 *
 * 1. **独立项目名**：默认 `noj-drill`，且**拒绝含 `prod`**——`down -v` 会删掉
 *    同名项目的**数据卷**，与生产同名等于删生产数据；
 * 2. **独立子网**：覆盖文件只改 `noj-net` 的 `ipam.config[0].subnet`，避免与
 *    生产 `noj-net` 冲突；
 * 3. **不映射宿主机端口**：覆盖文件**不含** `ports:`，因此演练不会占用
 *    8080/5432 等生产端口，也不会对外暴露。
 *
 * 数据卷隔离不需要额外配置：Compose 的卷名前缀是项目名，故演练卷天然是
 * `<演练项目名>_pgdata` 等，与生产卷不重叠。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { dirname, join } from "@std/path";
import type { CmdResult, CommandRunner } from "../../runtime/command.ts";
import { UsageError } from "../../util/args.ts";

/**
 * 校验演练项目名（原 `maintain/drill.ts`，T23 搬迁）。
 *
 * **拒绝包含 `prod`**（#516 验收）：演练必须用独立 Compose 项目，若与生产同名，
 * `docker compose down -v` 会**删掉生产数据卷**。这是不可逆的破坏，必须在开跑前拦下。
 *
 * 非法值抛 {@link UsageError}（退出码 2）——这是用法错误，不是演练失败。
 */
export function assertDrillProjectName(name: string): void {
  if (name.trim() === "") {
    throw new UsageError("演练项目名不能为空");
  }
  if (/prod/i.test(name)) {
    throw new UsageError(
      `演练项目名不得包含 "prod"（收到 "${name}"）——` +
        `演练会执行 compose down -v，与生产同名会删除生产数据卷。`,
    );
  }
}

/**
 * 校验子网格式（CIDR）（原 `maintain/drill.ts`，T23 搬迁）。
 *
 * **必须挡住 Docker 也会拒绝的输入**（#516 评审 P2）：早先只检查「四段数字 +
 * 前缀 8-30」，`999.1.1.1/16`、`172.29.1.1/16`（主机位不为 0）都会通过，
 * 直到 `docker network create` 才失败——而此时演练已进入 prepare 阶段，
 * 用户看到的是「演练失败(1)」，与 help/注释承诺的「参数错误 = 2」不符。
 *
 * 规则与 Docker/libnetwork 实测行为一致：每个 octet 在 0-255；前缀 8-30；
 * **主机位必须为 0**（即网络地址形式）。
 *
 * 非法值抛 {@link UsageError}（退出码 2），而不是普通 Error——否则会被 CLI
 * 当作运行失败(1)，正是评审指出的错误码不符。
 */
export function assertSubnetCidr(cidr: string): void {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    cidr.trim(),
  );
  if (!m) {
    throw new UsageError(
      `子网必须是 CIDR 形式（如 172.29.0.0/16），收到 "${cidr}"`,
    );
  }
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  for (const octet of octets) {
    if (octet < 0 || octet > 255) {
      throw new UsageError(`子网每段必须在 0-255 之间，收到 "${cidr}"`);
    }
  }
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 30) {
    throw new UsageError(`子网前缀应在 8-30 之间，收到 /${prefix}`);
  }
  // 主机位必须为 0：Docker 只接受网络地址形式的 --subnet。
  // /31、/32 不在允许前缀内，用 32 位掩码判定即可。
  const value = ((octets[0]! << 24) >>> 0) +
    (octets[1]! << 16) +
    (octets[2]! << 8) +
    octets[3]!;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  if (((value & mask) >>> 0) !== value) {
    throw new UsageError(
      `子网主机位必须为 0（应为网络地址，如 172.29.0.0/16），收到 "${cidr}"`,
    );
  }
}

/** 演练默认项目名（`NOJ_DRILL_PROJECT_NAME` 的缺省，bash :31）。 */
export const DEFAULT_DRILL_PROJECT_NAME = "noj-drill";

/** 演练默认子网（`NOJ_DRILL_SUBNET` 的缺省，bash :35）。 */
export const DEFAULT_DRILL_SUBNET = "172.29.0.0/16";

/** 默认 RPO 上限（小时，bash :36）。 */
export const DEFAULT_RPO_MAX_HOURS = 24;

/** 默认 RTO 上限（分钟，bash :37）。 */
export const DEFAULT_RTO_MAX_MINUTES = 60;

/** 默认 Compose 等待超时（秒，bash :38）。 */
export const DEFAULT_WAIT_TIMEOUT = 300;

/** 演练管理员账号（只存在于隔离演练库；bash :43-46）。 */
export const DRILL_ADMIN_USER = "drill_admin";
/** 演练管理员邮箱域（`.invalid` 保证不可达；bash :44）。 */
export const DRILL_ADMIN_EMAIL_DOMAIN = "restore-drill.invalid";
/** 演练管理员口令（固定，保证演练可复现；bash :45）。 */
export const DRILL_ADMIN_PASSWORD = "Drill-Recover-2026";
/** 演练管理员 bcrypt 哈希（cost 12；bash :46 逐字）。 */
export const DRILL_BCRYPT_HASH =
  "$2b$12$edDmxsubnHJL8B/Wsdryxu4ibNin0/SEhqAXkB.Yn50SCoN29lQCW";

/** judge_images 白名单缺失时的兜底评测镜像（bash :49-50）。 */
export const DEFAULT_EVALUATOR_IMAGE = "noj-evaluator-python";
/** judge_images 白名单缺失时的兜底解题镜像（bash :50）。 */
export const DEFAULT_SOLUTION_IMAGE = "noj-solution-python";

/** 演练所需的磁盘下限（bash 无此检查，见 {@link checkDrillResources}）。 */
export const DRILL_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** 演练网络名（覆盖文件里的键，bash :334 的 `noj-net`）。 */
export const DRILL_NETWORK_NAME = "noj-net";

/**
 * 生成演练 Compose 覆盖文件内容（`prepare_compose_override` :321-339 的等价）。
 *
 * 只做**两件事**：声明 `verifier` 服务（业务验收容器的载体）与把 `noj-net` 的
 * 子网改为演练子网。**刻意不含** `ports:`——这是"不映射宿主机端口"的落点，
 * 由测试逐字断言。
 *
 * 为什么需要覆盖而不是改生产文件：生产 `docker-compose.prod.yml` 受版本管理且
 * 被 CI/论文档引用，演练**不得**修改它；Compose 的多 `-f` 叠加语义正好用于此。
 */
export function renderDrillOverride(subnet: string): string {
  return `# restore-drill 自动生成的隔离覆盖：独立子网，避免与生产 noj-net 冲突。
services:
  verifier:
    image: denoland/deno:debian-2.9.5@sha256:5d46f925d213e9adaf18a0664b291fe973c91ba7b929572877610dcaaf09ee2b
    networks:
      - ${DRILL_NETWORK_NAME}
networks:
  ${DRILL_NETWORK_NAME}:
    ipam:
      config:
        - subnet: ${subnet}
`;
}

/**
 * 构造 `docker compose` 的**纯参数数组**（bash `compose()` :153-163 的等价）。
 *
 * 形状：`compose --project-name <演练名> --env-file <演练env> --file <生产compose>
 * --file <覆盖> [--profile judge] <子命令…>`。
 * 注意 `--project-name` **必须**在最前（它是隔离性的第一保证），且 profile 在
 * 子命令之前（Compose 的全局旗标语义，与 T10/T14 的 `--ansi` 同一类）。
 */
export function drillComposeArgs(opts: {
  projectName: string;
  composeEnvFile: string;
  composeFile: string;
  overrideFile: string;
  /** judge 是否启用（`--skip-judge` 时不带 profile）。 */
  judge: boolean;
  command: string[];
}): string[] {
  const args = [
    "compose",
    "--project-name",
    opts.projectName,
    "--env-file",
    opts.composeEnvFile,
    "--file",
    opts.composeFile,
    "--file",
    opts.overrideFile,
  ];
  if (opts.judge) args.push("--profile", "judge");
  args.push(...opts.command);
  return args;
}

/** {@link drillCleanupArgs} 的参数。 */
export interface CleanupArgsOptions {
  projectName: string;
  composeEnvFile: string;
  composeFile: string;
  /** 覆盖文件路径；演练目录已被删时传 undefined（bash `on_exit` 的同一判定）。 */
  overrideFile?: string;
}

/**
 * 构造 `down -v --remove-orphans` 的参数（bash `on_exit` :165-186 的等价）。
 *
 * `-v` 是**必需**的：演练卷留着的唯一后果是占盘，且下次演练会因卷已存在而
 * 复用到脏数据。这里与生产的安全性无关——项目名不同，卷名前缀就不同。
 */
export function drillCleanupArgs(opts: CleanupArgsOptions): string[] {
  const args = [
    "compose",
    "--project-name",
    opts.projectName,
    "--env-file",
    opts.composeEnvFile,
    "--file",
    opts.composeFile,
  ];
  if (opts.overrideFile !== undefined) {
    args.push("--file", opts.overrideFile);
  }
  args.push("down", "-v", "--remove-orphans");
  return args;
}

/** 演练目录的默认名（`drill-<时间戳>`，bash :288）。 */
export function drillDirName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `drill-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}` +
    `${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}` +
    `${p(now.getUTCSeconds())}`;
}

/**
 * 分配演练目录（bash :288-295 的等价）：默认在**快照同级**，冲突时追加序号。
 *
 * 与快照同级是有意的：演练目录里要放解包后的 payload 与日志，放在快照旁边
 * 便于 `--keep` 时人工检查（bash 同样如此）。
 */
export async function allocateDrillDir(
  snapshotPath: string,
  now: Date,
  explicit?: string,
): Promise<string> {
  if (explicit !== undefined && explicit !== "") {
    if (await pathExists(explicit)) {
      throw new UsageError(`演练目录已存在：${explicit}`);
    }
    return explicit;
  }
  const base = join(
    dirname(snapshotPath.replace(/\/+$/, "")),
    drillDirName(now),
  );
  let candidate = base;
  let index = 1;
  while (await pathExists(candidate)) {
    candidate = `${base}-${index}`;
    index++;
  }
  return candidate;
}

/** `-e` 语义的存在性判定（含悬空软链）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 报告路径（bash :296-299 + `maintain/drill.ts:279-291` 的同一语义）。
 *
 * 默认写在**快照目录之内**的 `restore-drill-report.txt`。注意对**单文件快照**
 * 来说，"快照目录"是其所在目录——因此这里用 `dirname` 而非把快照当成目录
 * （`maintain/drill.ts` 的旧实现假定快照是目录，对单文件会拼出不存在的路径）。
 */
export function resolveReportPath(
  snapshotPath: string,
  explicit?: string,
): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  const clean = snapshotPath.replace(/\/+$/, "");
  // 单文件容器：报告写到它**所在目录**；目录快照：写到该目录**之内**。
  return clean.endsWith(".nojbackup")
    ? join(dirname(clean), "restore-drill-report.txt")
    : join(clean, "restore-drill-report.txt");
}

/** 演练的资源/参数前置失败（退出码 2 的语义载体）。 */
export class DrillPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrillPreflightError";
  }
}

/**
 * 演练前置：环境、口令、docker、磁盘、报告可写（bash `preflight` :250-281 的等价，
 * 但把 docker/磁盘探测改为**注入**以便测试与"零 compose 调用"断言）。
 *
 * 与 bash 的差异（都在 {@link DrillPreflightOptions} 的 JSDoc 中说明）：
 * - bash 用 `bash backup.sh verify` 做文件校验；本实现用 T18 的 `verifyContainer`
 *   （原生，且对单文件形态天然支持）；
 * - bash 在 preflight 里 `die`（退出码 1）；本实现抛 {@link DrillPreflightError}，
 *   由编排层映射为**退出码 2**（#516 验收："资源缺失 = 2，且必须在开始前"）。
 */
export interface DrillPreflightOptions {
  /** 解包后的快照 staging 目录（已校验）。 */
  staging: string;
  /** 生产安装目录。 */
  dir: string;
  /** 生产 `.env.prod` 路径。 */
  envFile: string;
  /** 生产 compose 文件路径。 */
  composeFile: string;
  /** 演练项目名（已校验）。 */
  projectName: string;
  /** 磁盘可用字节探测（注入；缺省不探测 = 测试友好的 no-op）。 */
  freeBytes?: () => Promise<number>;
  /** docker 可用性探测（注入；缺省不探测）。 */
  dockerAvailable?: () => Promise<boolean>;
}

/**
 * 执行前置校验；任一不过即抛 {@link DrillPreflightError}。
 *
 * **顺序对齐 bash**：快照 → 口令 → 生产环境文件 → compose → docker → 项目名 →
 * 数值。全部在**起任何容器之前**，因此"前置失败 ⇒ 零 compose 调用"。
 */
export async function checkDrillPreflight(
  opts: DrillPreflightOptions,
): Promise<void> {
  // 快照必需条目（bash :264-268）：校验由 T18 的 verifyContainer 完成，
  // 这里只断言它对容器形态的结论（payload_layout 已由 verify 校验）。
  if (!(await isFile(join(opts.staging, "manifest.json")))) {
    throw new DrillPreflightError("快照缺少 manifest.json");
  }
  if (!(await isFile(join(opts.staging, "SUCCESS")))) {
    throw new DrillPreflightError("快照缺少成功标记 SUCCESS");
  }
  if (!(await isFile(opts.envFile))) {
    throw new DrillPreflightError(`生产环境文件不存在：${opts.envFile}`);
  }
  if (!(await isFile(opts.composeFile))) {
    throw new DrillPreflightError(
      `生产 Compose 文件不存在：${opts.composeFile}`,
    );
  }
  if (opts.dockerAvailable !== undefined && !(await opts.dockerAvailable())) {
    throw new DrillPreflightError(
      "无法连接 Docker（演练需要起隔离容器）；请确认 Docker 已安装并运行",
    );
  }
  // 磁盘：演练要恢复完整数据 + 起容器（bash 无此检查，这里保留 noj-cli 既有行为）
  if (opts.freeBytes !== undefined) {
    const free = await opts.freeBytes();
    if (Number.isFinite(free) && free < DRILL_MIN_FREE_BYTES) {
      throw new DrillPreflightError(
        `磁盘可用空间不足：需要 ≥${
          (DRILL_MIN_FREE_BYTES / 1024 / 1024 / 1024).toFixed(0)
        }GiB，当前 ${(free / 1024 / 1024 / 1024).toFixed(1)}GiB`,
      );
    }
  }
}

/** `-f` 语义的普通文件判定。 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * 探测磁盘可用空间（`df -Pk <dir>` 的等价，经注入 runner）。
 *
 * 用 `df` 而非 `Deno.statfs`：后者在 Deno 2.9 的稳定 API 中不存在
 * （`maintain/drill.ts:204-205` 的既有结论）。
 */
export function probeFreeBytes(
  runner: CommandRunner,
  dir: string,
): () => Promise<number> {
  return async () => {
    const res: CmdResult = await runner.run("df", ["-Pk", dir]);
    if (res.code !== 0) return Number.POSITIVE_INFINITY;
    const lines = res.stdout.trim().split("\n");
    const cols = lines[lines.length - 1]?.split(/\s+/) ?? [];
    // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted
    const availKb = Number(cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : Number.POSITIVE_INFINITY;
  };
}

/** 探测 docker 可用性（`docker info` 的等价，经注入 runner）。 */
export function probeDocker(
  runner: CommandRunner,
  dockerBin: string,
): () => Promise<boolean> {
  return async () => {
    try {
      return (await runner.run(dockerBin, ["info"])).code === 0;
    } catch {
      return false;
    }
  };
}

/**
 * 校验口令文件权限（bash `check_secret_file` :114-121 的等价）。
 *
 * 600/400 之外一律拒绝：口令文件是可读即得收益的机密，宽松权限等于把
 * "异地独立保管"这条要求作废。
 */
export async function checkPassphraseFile(path: string): Promise<void> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(path);
  } catch {
    throw new DrillPreflightError(`GPG 口令文件不存在：${path}`);
  }
  if (!st.isFile) {
    throw new DrillPreflightError(`GPG 口令文件不是普通文件：${path}`);
  }
  const mode = ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0");
  if (mode !== "600" && mode !== "400") {
    throw new DrillPreflightError(
      `GPG 口令文件权限必须为 600 或 400：${path}（当前 ${mode}）`,
    );
  }
}

/**
 * 解析 `.env.prod` 的键值（bash `env_value` :98-108 的等价）。
 *
 * 复用 T3 `core/env-file.ts` 的解析器；缺失文件返回空表（bash 同样 `return 0`）。
 */
export async function readEnvValues(
  envFile: string,
): Promise<Record<string, string>> {
  const { parseEnvFile } = await import("../../core/env-file.ts");
  let text: string;
  try {
    text = await Deno.readTextFile(envFile);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of parseEnvFile(text)) out[k] = v;
  return out;
}

/** 带缺省值的取值（bash `${VAR:-default}` 的等价）。 */

// `valueOr` 已移到 `prod/env-values.ts`（生产 restore 也要用，避免 backup→drill
// 的反向依赖）。此处**再导出**以保持既有导入点不变。
export { valueOr } from "../env-values.ts";
