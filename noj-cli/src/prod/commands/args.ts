/** 生产命令的通用参数解析辅助（`--dir`、旗标取值与未实现旗标守卫）。 */

import { UsageError } from "../../util/args.ts";

/** 生产命令的解析结果：`--dir` 与其余参数分开。 */
export interface ProdArgs {
  /** `--dir <path>` / `--dir=<path>`；未给出为 undefined。 */
  dir: string | undefined;
  /** 其余参数（原样交给本命令的解析逻辑）。 */
  rest: string[];
}

/**
 * 拆出 `--dir`（T23 后 CLI 只剩这一种目录旗标）。
 *
 * **只认 `--dir`**：`--install-dir` 是 Tier 3 容器命令的旗标（指宿主机安装目录），
 * 在生产命令上出现应报错而不是被悄悄吞掉——静默吞掉会让用户以为它生效了。
 */
export function parseProdArgs(args: string[]): ProdArgs {
  let dir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--dir 需要一个目录路径");
      }
      dir = value;
      i++;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length);
      if (value === "") throw new UsageError("--dir 需要一个目录路径");
      dir = value;
      continue;
    }
    if (arg === "--install-dir" || arg.startsWith("--install-dir=")) {
      throw new UsageError(
        "--install-dir 是 Tier 3 容器命令的旗标；生产命令请使用 --dir <安装目录>",
      );
    }
    rest.push(arg);
  }
  return { dir, rest };
}

/** `--json` 是否开启（原生实现自己也会判，这里只为统一读取）。 */
export function hasJson(args: string[]): boolean {
  return args.includes("--json");
}

/** 取 `--flag value` 或 `--flag=value` 的值。 */
export function flagValue(
  args: string[],
  name: string,
): string | undefined {
  const eq = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      return value;
    }
    if (arg.startsWith(eq)) {
      const value = arg.slice(eq.length);
      if (value === "") throw new UsageError(`${name} 需要一个值`);
      return value;
    }
  }
  return undefined;
}

/**
 * 读一个**非负整数**旗标；缺省返回 undefined，非法值抛用法错误。
 *
 * 存在的理由：这类值会被下游当作**数量/天数**参与"保护哪些备份"的计算，
 * 而非法的 `NaN` 在 `slice`/比较里会静默退化为"什么都不保护"——
 * 也就是说校验缺失的后果是**删数据**，不是报错。
 */
export function optionalCount(
  args: string[],
  name: string,
): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  // 只接受十进制非负整数（拒绝 "1.5"、"1e3"、"0x10"、"-1"、""）
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${name} 必须是非负整数，收到 "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(`${name} 超出可用范围，收到 "${raw}"`);
  }
  return n;
}

/** 取布尔旗标（支持 `-y` 这类短名）。 */
export function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

/**
 * 生产命令上**未实现却会被静默吞掉**的旗标 → 拒绝并说明原因。
 *
 * ## 为什么必须拒绝而不是忽略（评审发现的数据丢失）
 *
 * `--dry-run` 是 bash 的真实选项（`deploy.sh:110`），且在破坏性路径上有守卫：
 * `production.sh:506` 的 `if ((remove_all && !dry_run))` 与 `:511` 的
 * `if (( !dry_run ))` 明确**在 dry-run 下不做 `unregister_command` 与
 * `remove_install_directory`**。TS 版既没实现它、也没拒绝它，于是：
 *
 * ```
 * $ rm -rf y2 && mkdir -p y2/bin && ... && touch y2/important.txt
 * $ noj-cli uninstall --all --yes --dry-run --dir /tmp/y2
 * ✓ 已删除 NOJ 安装目录：/tmp/y2        ← 真的删了
 * EXITCODE=0                            ← 而且报成功
 * ```
 *
 * 即用户执行"给我看看会做什么"的命令，**真删了整个安装目录与数据卷**。
 * 这比"旗标不存在"更危险：没有报错，用户的预期与结果完全相反。
 *
 * 因此：**未实现的旗标必须显式拒绝（退出码 2）**，而不是静默忽略。
 * 这同时给未来的实现留了明确位置——实现后从本表移除即可。
 */
const UNIMPLEMENTED_PROD_FLAGS: Record<string, string> = {
  "--dry-run": "生产命令尚未实现 --dry-run；该旗标此前被静默忽略，会让看似" +
    "预演的命令真的执行（uninstall --all 会真的删除目录与数据卷）。" +
    "如需确认将要执行的 compose 命令，请先阅读 noj-cli/README.md 的说明，" +
    "或对破坏性操作使用 --help 查看其确切语义",
  "--panel": "生产命令尚未实现 --panel（面板模式 auto|baota|none）；" +
    "面板只做探测与提示，不影响部署结果",
};

/**
 * 拒绝未实现的生产旗标（在任何副作用之前）。
 *
 * `allow` 用于**已实现**该旗标的子命令：`judge` 的 `install`/`install-env`
 * 等确实支持 `--dry-run`（有完整分支，校验后直接返回不写文件），
 * 因此必须放行——否则"拒绝未实现的旗标"会误伤已实现的能力
 * （实测过：`judge install --dry-run` 曾被这条守卫拦截）。
 */
export function rejectUnimplementedProdFlags(
  args: string[],
  allow: readonly string[] = [],
): void {
  for (const arg of args) {
    // 同时覆盖 `--flag` 与 `--flag=value` 两种写法
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (allow.includes(name)) continue;
    const hint = UNIMPLEMENTED_PROD_FLAGS[name];
    if (hint !== undefined) throw new UsageError(hint);
  }
}

/** 位置参数（跳过所有 `--xxx` 与它们的值）。 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  const valueTaking = new Set([
    "--dir",
    "--env-file",
    "--compose-file",
    "--backup-dir",
    "--passphrase-file",
    "--panel",
    "--tail",
    "--schedule",
    "--project-name",
    "--docker-host",
    "--subnet",
    "--report",
    "--rpo-max-hours",
    "--rto-max-minutes",
    "--zstd-level",
    "--keep",
    "--retention-days",
    "--min-free-mb",
    "--ref",
    // **带值的旗标必须登记在此**（评审发现）：`positionals()` 靠这份清单决定
    // "是否跳过下一个 token"，漏登记会让旗标的**值**被当成位置参数。
    // 实测 `backup restore --restore-env /tmp/custom.env snap.nojbackup`
    // 会把 `/tmp/custom.env` 当成快照路径，报"只支持 .nojbackup 单文件快照"。
    "--restore-env",
    "--repo",
    "--version",
    "--redis-url",
    "--socket-path",
    "--socket-gid",
    "--redis-port",
    "--redis-container",
    "--redis-mode",
    "--older-than",
    "--input",
    "--output",
    "--benchmark",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      // `--flag=value` 自带值；`--flag value` 跳过下一个
      if (!arg.includes("=") && valueTaking.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
