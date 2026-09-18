/**
 * `backup drill` = **真实恢复演练**（#516）。
 *
 * 与 `backup verify` 的分工（名字即保证强度）：
 *
 * | 命令 | 保证 | 成本 |
 * | --- | --- | --- |
 * | `verify` | 文件完整（sha256 + 解密） | 秒级 |
 * | `verify --deep` | 结构可解析 | 十秒级 |
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
 * - 资源不足在**开始前**报错（退出码 2），而不是中途失败。
 */
import { join } from "@std/path";

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
 */
export function assertDrillProjectName(name: string): void {
  if (name.trim() === "") {
    throw new Error("演练项目名不能为空");
  }
  if (/prod/i.test(name)) {
    throw new Error(
      `演练项目名不得包含 "prod"（收到 "${name}"）——` +
        `演练会执行 compose down -v，与生产同名会删除生产数据卷。`,
    );
  }
}

/** 校验子网格式（CIDR）。 */
export function assertSubnetCidr(cidr: string): void {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    cidr.trim(),
  );
  if (!m) {
    throw new Error(`子网必须是 CIDR 形式（如 172.29.0.0/16），收到 "${cidr}"`);
  }
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 30) {
    throw new Error(`子网前缀应在 8-30 之间，收到 /${prefix}`);
  }
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
export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  // 参数/资源错误 → 2（用法错误），在**开跑前**决出
  assertDrillProjectName(opts.projectName ?? "noj-drill");
  if (opts.subnet !== undefined) assertSubnetCidr(opts.subnet);
  await checkDrillResources(opts.dir);

  const result = await new Deno.Command("bash", {
    args: buildDrillArgs(opts),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  const code = result.code;
  // 脚本自身用 0/1 区分通过/失败；其他非零（如 2/127）视为演练失败
  const pass = code === 0;
  return {
    pass,
    exitCode: pass ? 0 : 1,
    reportPath: opts.report ?? null,
    message: pass
      ? "恢复演练通过：隔离环境成功恢复并通过业务验收"
      : `恢复演练失败（restore-drill.sh 退出码 ${code}）`,
  };
}
