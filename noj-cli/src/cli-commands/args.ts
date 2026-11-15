// Tier 3 自有旗标的剥离与解析，以及字节数格式化。

import { UsageError } from "../util/args.ts";

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

/** 人类可读字节数（备份 list 展示用，#515 P6）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "M";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + "G";
}
