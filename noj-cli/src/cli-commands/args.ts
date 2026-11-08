// 旗标剥离与位置参数解析工具（门面 cli.ts 与容器分发共用）。

import { UsageError } from "../util/args.ts";

/**
 * 剥离 CLI 自身的全局选项（`--profile`、`--debug`），其余原样保留。
 *
 * **`--debug` 必须一并剥离**（评审 B3）：它是 noj-cli 自己的排查开关，
 * 不是子命令/容器内 noj 的选项。若不剥离：
 * - 生产命令会把 `--debug` 传给 `production.sh`（其参数契约不接受）；
 * - Tier 3 会把它透传进容器，容器内 noj 报「未知选项」；
 * - 放在子命令之后还会被当成未知顶层命令。
 * 三种表现都是「help 说是全局选项、实际不可用」。
 *
 * 这两个选项语义属于 noj-cli 本身，**不能**透传给子命令或底层脚本。
 */
export function extractProfile(argv: string[]): {
  profile: string | undefined;
  rest: string[];
} {
  let profile: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--debug") {
      // 评审 B3：--debug 是 CLI 自身的全局排查开关，必须在**顶层**剥离。
      // 否则放在子命令前会被当成未知命令，放在子命令后会被转发给
      // production.sh 或透传进容器（help 却把它列为全局选项）。
      continue;
    }
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        // `stack` 已随 T23 删除；错误信息里不能再提它（评审发现：这是
        // 唯一残留的"已删模式"用户可见文案，而 T26 的 help 门禁只查 help、
        // 不查错误文本，所以它逃过了那道门禁）。
        throw new UsageError("--profile 需要一个值（仅支持 prod）");
      }
      profile = value;
      i++;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else {
      rest.push(arg);
    }
  }
  return { profile, rest };
}

/**
 * 剔除属于 noj-cli 自身的选项（`--dir` 及其值、`--dry-run`），
 * 使容器内的 noj 只看到它认识的参数。
 */
export function stripCliOwnedFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") continue;
    // 评审 B3：--debug 是 noj-cli 自身的排查开关，必须剥离后再转发，
    // 否则会被子命令/容器当作未知选项（help 却把它列为全局选项）。
    if (arg === "--debug") continue;
    // 评审 M1：Tier 3 命令的 --dir 存在双语义冲突——noj-cli 用它指安装目录，
    // 而容器内的 noj 用它指子命令参数（如 problems import --dir <包目录>）。
    // 因此 CLI 自身的安装目录选项改名为 --install-dir，容器侧的 --dir 原样透传。
    if (arg === "--install-dir") {
      i++;
      continue;
    }
    if (arg.startsWith("--install-dir=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * 解析 Tier 3 命令的安装目录（`--install-dir`）。
 *
 * 与 `--dir` 分开的原因见 {@link stripCliOwnedFlags}（评审 M1）。
 */
export function parseInstallDirArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--install-dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--install-dir 需要一个安装目录");
      }
      return value;
    }
    if (arg.startsWith("--install-dir=")) {
      const value = arg.slice("--install-dir=".length);
      if (value === "") throw new UsageError("--install-dir 需要一个安装目录");
      return value;
    }
  }
  return undefined;
}

/** 取第一个位置参数（跳过选项及其值）。 */
export function firstPositional(
  args: string[],
  valueFlags: string[] = ["--dir", "--profile"],
): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      i++; // 跳过该选项的值
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

/** 人类可读字节数（备份 list 展示用，#515 P6）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "M";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + "G";
}

/** 移除第一个位置参数（保留其余顺序与选项值）。 */
export function removeFirstPositional(
  args: string[],
  valueFlags: string[] = ["--dir", "--install-dir", "--profile"],
): string[] {
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      out.push(arg);
      const value = args[i + 1];
      if (value !== undefined) {
        out.push(value);
        i++;
      }
      continue;
    }
    if (!removed && !arg.startsWith("-")) {
      removed = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}
