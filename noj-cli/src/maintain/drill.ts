/**
 * `backup drill` = **真实恢复演练**（#516）。
 *
 * 与 `backup verify` 的分工（名字即保证强度）：
 *
 * | 命令 | 保证 | 成本 |
 * | --- | --- | --- |
 * | `verify` | 文件完整（sha256 + 解密） | 秒级 |
 * | `verify --deep` | 结构可解析（#515 提供，本 PR 尚未实现） | 十秒级 |
 * | `drill` | **真的能恢复**（隔离环境实恢复 + 业务验收） | 分钟级，需 Docker |
 *
 * 本模块是 `scripts/deploy/restore-drill.sh` 的薄包装：**不在 CLI 里重写**
 * 隔离/恢复/验收逻辑（那套实现已正确处理独立项目、独立子网、不映射端口、
 * 失败诊断），只做参数校验、资源前置检查与报告归一。
 *
 * 设计要点（#516 验收）：
 * - 默认**清理**演练资源，`--keep` 才保留（失败路径也必须清理）；
 * - 项目名**拒绝包含 prod**，避免误伤生产；
 * - RPO/RTO 超限视为**演练失败**（退出码 1），不是警告；
 * - 资源不足在**开始前**报错（退出码 2），而不是中途失败；
 * - **只接受 `snapshot-*` 目录快照**：`.nojbackup` 单文件在**参数阶段**明确
 *   拒绝（退出码 2）并给出可用恢复路径，不再让它落到 preflight 报
 *   「快照目录不存在」（#516 评审 P1，详见 {@link assertDrillSnapshotSupported}）。
 */
import { join } from "@std/path";
import { UsageError } from "../util/args.ts";

/** drill 选项。 */
export interface DrillOptions {
  /** 快照路径（必填）。 */
  snapshotPath: string;
  /** 生产安装目录。 */
  dir: string;
  /** 跳过 Judge 相关验收。 */
  skipJudge: boolean;
  /** 演练网络子网。 */
  subnet: string | undefined;
  /** 演练 Compose 项目名。 */
  projectName: string | undefined;
  /** 报告路径。 */
  report: string | undefined;
  /** RPO 上限（小时）。 */
  rpoMaxHours: number | undefined;
  /** RTO 上限（分钟）。 */
  rtoMaxMinutes: number | undefined;
  /** 保留演练环境。 */
  keep: boolean;
  /** 机器可读输出。 */
  json: boolean;
  /** 口令文件。 */
  passphraseFile: string | undefined;
}

/** drill 结果。 */
export interface DrillResult {
  pass: boolean;
  /** 退出码（0 通过 / 1 演练失败 / 2 资源或参数错误）。 */
  exitCode: number;
  reportPath: string | null;
  message: string;
}

/**
 * 校验项目名。
 *
 * **拒绝包含 `prod`**（#516 验收）：演练必须用独立 Compose 项目，
 * 若与生产同名，`docker compose down -v` 会**删掉生产数据卷**。
 * 这是不可逆的破坏，必须在开跑前拦下。
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
 * 校验子网格式（CIDR）。
 *
 * **必须挡住 Docker 也会拒绝的输入**（#516 评审 P2）：早先只检查「四段数字 +
 * 前缀 8-30」，`999.1.1.1/16`、`172.29.1.1/16`（主机位不为 0）都会通过，
 * 直到 `docker network create` 才失败——而此时演练已进入 prepare 阶段，
 * 用户看到的是「演练失败(1)」，与 help/注释承诺的「参数错误 = 2」不符。
 *
 * 规则与 Docker/libnetwork 实测行为一致：
 * - 每个 octet 必须在 0-255（`999.1.1.1/16` 直接拒绝）；
 * - 前缀 8-30（与 restore-drill.sh / Compose 的可用范围一致）；
 * - **主机位必须为 0**（即网络地址形式）：`172.29.1.1/16` 被 Docker
 *   以 `invalid network config` 拒绝，必须在开跑前拦下。
 *
 * 非法值抛 {@link UsageError}（退出码 2），而不是普通 Error——否则会被
 * CLI 当作运行失败(1)，正是评审指出的错误码不符。
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

/**
 * 判断快照是否为 #515 统一后的**单文件** `.nojbackup`。
 *
 * `restore-drill.sh` 的 `validate_snapshot_path` 强制要求快照是
 * `snapshot-*` **目录**，单文件会在 preflight 直接报「快照目录不存在」
 * （#533/#514 已识别的格式，backup list 会把它标注为 single）。
 */
export function isSingleSnapshotFile(snapshotPath: string): boolean {
  return snapshotPath.trim().toLowerCase().endsWith(".nojbackup");
}

/**
 * 校验快照形态是否被 `drill` 支持（#516 评审 P1）。
 *
 * **单文件 `.nojbackup` 不能交给 `restore-drill.sh`，且不能靠「解包到临时
 * 目录」绕过**——两种形态的内部布局本就不同（已实测确认）：
 *
 * | 条目 | 生产目录快照（`backup.sh create`） | 单文件 `.nojbackup`（`backupCreate`） |
 * | --- | --- | --- |
 * | `postgres.dump` | `pg_dump -Fc` **原始二进制** | base64 **文本**（经 stdout 传输） |
 * | `env.prod.gpg` | GPG 加密的生产环境文件 | 不存在（环境在 `noj-secrets.json`） |
 * | `postgres.restore-list` | `pg_restore --list` 结构清单 | 不存在 |
 * | `redis.rdb` | redis-cli `--rdb` 原始二进制 | base64 文本 |
 * | 顶层配置 | `.env.prod` | `noj-deploy.json` / `noj-secrets.json` |
 *
 * 因此仅解包得到的目录仍会卡在 `backup.sh verify`（「PostgreSQL dump 结构
 * 清单为空」），即便补齐校验清单，`restore-drill.sh` 也会把 base64 文本
 * 当作 `pg_restore` 输入而恢复出垃圾数据——**这是比报错更糟的静默错误**。
 *
 * 所以在**参数阶段**明确拒绝（退出码 2）并给出确实可用的恢复路径，
 * 而不是假装支持后让用户在半途看到误导性的失败。
 *
 * @throws {UsageError} 收到单文件快照
 */
export function assertDrillSnapshotSupported(snapshotPath: string): void {
  if (!isSingleSnapshotFile(snapshotPath)) return;
  throw new UsageError(
    `drill 不支持单文件快照：${snapshotPath}\n` +
      "  原因：#515 的 .nojbackup 是 JSON 编排模式（maintain）的格式，其内部布局" +
      "（base64 文本转储、noj-deploy/noj-secrets 配置、无 env.prod.gpg）" +
      "与生产目录快照（restore-drill.sh 直接 pg_restore 的原始 dump）不同，" +
      "解包后也无法安全恢复。\n" +
      "  可用的恢复路径：\n" +
      "    - JSON 编排模式恢复：noj-cli maintain backup restore <快照> --confirm\n" +
      "    - 仅校验文件完整性：noj-cli maintain backup verify <快照>\n" +
      "    - 生产目录快照（backup.sh create 生成 snapshot-* 目录）仍可直接 backup drill",
  );
}

/**
 * 资源前置检查（#516：缺资源时**明确报错**而非中途失败）。
 *
 * 只做快速、无副作用的检查；真正的拉镜像/起容器由脚本负责。
 */
export async function checkDrillResources(_dir: string): Promise<void> {
  // Docker 可用性：演练必须有可用 daemon
  try {
    const out = await new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!out.success) {
      throw new Error("Docker daemon 不可用");
    }
  } catch {
    throw new Error(
      "无法连接 Docker（演练需要起隔离容器）；请确认 Docker 已安装并运行",
    );
  }
  // 磁盘空间：演练要恢复完整数据 + 起容器，低于 2GiB 直接拒绝。
  // 用 `df` 而非 Deno.statfs——后者在 Deno 2.9 的稳定 API 中不存在。
  const REQUIRED = 2 * 1024 * 1024 * 1024;
  try {
    const df = await new Deno.Command("df", {
      args: ["-Pk", _dir],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (df.success) {
      const text = new TextDecoder().decode(df.stdout).trim().split("\n");
      const cols = text[text.length - 1]?.split(/\s+/);
      // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted
      const availKb = Number(cols?.[3]);
      if (Number.isFinite(availKb)) {
        const freeBytes = availKb * 1024;
        if (freeBytes < REQUIRED) {
          throw new Error(
            `磁盘可用空间不足：需要 ≥${
              (REQUIRED / 1024 / 1024 / 1024).toFixed(0)
            }GiB，当前 ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)}GiB`,
          );
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("磁盘")) throw e;
    // df 不可用：不阻断（不同平台差异）
  }
}

/**
 * 组装 `restore-drill.sh` 的参数数组（**不做 shell 拼接**）。
 *
 * 单独成函数便于单测：参数错误是用法错误（退出码 2），
 * 不应等到脚本跑起来才发现。
 */
export function buildDrillArgs(opts: DrillOptions): string[] {
  const script = join(opts.dir, "scripts/deploy/restore-drill.sh");
  const args = [script, opts.snapshotPath];
  if (opts.skipJudge) args.push("--skip-judge");
  if (opts.subnet !== undefined) args.push("--subnet", opts.subnet);
  if (opts.projectName !== undefined) {
    args.push("--project-name", opts.projectName);
  }
  if (opts.report !== undefined) args.push("--report", opts.report);
  if (opts.rpoMaxHours !== undefined) {
    args.push("--rpo-max-hours", String(opts.rpoMaxHours));
  }
  if (opts.rtoMaxMinutes !== undefined) {
    args.push("--rto-max-minutes", String(opts.rtoMaxMinutes));
  }
  if (opts.passphraseFile !== undefined) {
    args.push("--passphrase-file", opts.passphraseFile);
  }
  if (opts.keep) args.push("--keep");
  return args;
}

/**
 * 执行真实恢复演练。
 *
 * 退出码语义（#516 验收）：
 * - `0` 演练通过
 * - `1` 演练失败（含业务验收失败、超 RPO/RTO）
 * - `2` 参数或资源错误
 */
/**
 * 报告路径：显式 `--report` 优先；否则脚本默认写在快照目录下的
 * `restore-drill-report.txt`（评测发现 `--json` 里恒为 null，
 * 文本模式也不告知用户去哪找报告）。
 *
 * 只对**目录快照**调用：单文件已在 {@link assertDrillSnapshotSupported}
 * 阶段被拒绝，不会走到这里（早先单文件会被拼成 `.nojbackup` 内部路径）。
 */
export function resolveDrillReportPath(
  snapshotPath: string,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return explicit;
  // **快照是目录**（restore-drill.sh 的 validate_snapshot_path 强制 `[[ -d ]]`
  // 且要求 basename 为 `snapshot-*`），报告写在**该目录之内**：
  // `REPORT="$SNAPSHOT/restore-drill-report.txt"`（restore-drill.sh:291）。
  // 早先取 dirname(snapshot) 会恒指向一个**不存在**的路径，
  // 连带使「读回报告判定 RPO/RTO」永远读不到（评测发现的 M1+M2 连带缺陷）。
  const base = snapshotPath.replace(/\/+$/, "");
  return `${base}/restore-drill-report.txt`;
}

export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  // 参数/资源错误 → 2（用法错误），在**开跑前**决出。
  // 纯参数校验放在最前：不依赖 Docker/磁盘，开跑前的用法错误不应被资源
  // 检查的错误信息掩盖（#516 评审 P2 要求非法参数稳定返回 2）。
  assertDrillProjectName(opts.projectName ?? "noj-drill");
  assertDrillSnapshotSupported(opts.snapshotPath);
  if (opts.subnet !== undefined) assertSubnetCidr(opts.subnet);
  await checkDrillResources(opts.dir);

  // `--json` 时 stdout 必须**只含 JSON**（评测发现：脚本的人类日志
  // 与 CLI 的 JSON 混在同一 stdout，导致 `jq`/`json.load` 解析失败）。
  // Deno 的 stdout 没有 "stderr" 选项，故 json 模式改为 **piped 捕获后
  // 转写到 stderr**：日志仍可见，但不污染机器可读的 stdout。
  // 非 json 模式保持 inherit（交互与实时日志体验不变）。
  const jsonMode = opts.json === true;
  const child = new Deno.Command("bash", {
    args: buildDrillArgs(opts),
    stdin: "inherit",
    stdout: jsonMode ? "piped" : "inherit",
    stderr: "inherit",
  });
  const result = await child.output();
  if (jsonMode) {
    const captured = new TextDecoder().decode(result.stdout);
    if (captured.length > 0) {
      // 保留脚本日志的可见性，但走 stderr
      await Deno.stderr.write(new TextEncoder().encode(captured));
    }
  }

  const code = result.code;
  const reportPath = resolveDrillReportPath(opts.snapshotPath, opts.report);

  // #516 验收：「RPO/RTO 是**硬阈值**——超限应视为**演练失败**，而非警告」。
  // 但 restore-drill.sh 对超限只写 `result=passed_with_warnings` 并仍 exit 0。
  // 因此这里读回报告，把该标记提升为失败——否则「演练」失去意义
  //（评测发现：超 RPO/RTO 时 CLI 仍返回 0）。
  let rpoRtoBreach = false;
  try {
    const text = await Deno.readTextFile(reportPath);
    if (/^result=passed_with_warnings$/m.test(text)) rpoRtoBreach = true;
  } catch {
    // 报告不存在/不可读：不据此判定失败，交由退出码决定
  }

  const pass = code === 0 && !rpoRtoBreach;
  return {
    pass,
    exitCode: pass ? 0 : 1,
    reportPath,
    message: rpoRtoBreach
      ? "恢复演练失败：RPO/RTO 未达标（详见报告）——演练要求硬阈值达标"
      : pass
      ? "恢复演练通过：隔离环境成功恢复并通过业务验收"
      : `恢复演练失败（restore-drill.sh 退出码 ${code}）`,
  };
}
