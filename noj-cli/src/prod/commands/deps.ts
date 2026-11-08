/** 生产命令的依赖装配与数值/口令解析辅助（`prodDeps`、`envNumber` 等）。 */

import type { CommandRunner } from "../../runtime/command.ts";
import { realRunner } from "../../runtime/command.ts";
import { realIO } from "../../tui/io.ts";
import type { PromptIO } from "../../tui/io.ts";
import { UsageError } from "../../util/args.ts";
import { flagValue } from "./args.ts";
import type { ProdCliDeps } from "./types.ts";

/** 装配公共依赖（缺省值即生产路径）。 */
export function prodDeps(deps: ProdCliDeps): {
  runner: CommandRunner;
  io: PromptIO;
  isTty: () => boolean;
  processEnv: Record<string, string>;
} {
  return {
    runner: deps.runner ?? realRunner(),
    io: deps.io ?? realIO(),
    isTty: deps.isTty ?? (() => Deno.stdin.isTerminal()),
    processEnv: deps.processEnv ?? Deno.env.toObject(),
  };
}

/**
 * 解析 GPG 口令文件路径（`--passphrase-file` > 进程环境 > `.env.prod`）。
 *
 * **为什么必须集中解析**（评审发现）：`backup drill` 的报错文案明示
 * "必须提供 `--passphrase-file` 或 `NOJ_BACKUP_PASSPHRASE_FILE`"，但该环境变量
 * 此前对 `drill`/`verify`/`restore` **全未接线**——设了也报同一错误；
 * 而 `install` 恰会把它回填进 `.env.prod`，形成"安装时写进去、备份校验时用不上"。
 * 优先级与 `backupPassphrasePath` 一致（bash deploy.sh:924）。
 */
export function resolveBackupPassphrase(
  args: string[],
  opts: { env?: Record<string, string>; configured?: string } = {},
): string | undefined {
  const flag = flagValue(args, "--passphrase-file");
  if (flag !== undefined && flag !== "") return flag;
  const explicit = (opts.env ?? {})["NOJ_BACKUP_PASSPHRASE_FILE"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const configured = opts.configured;
  if (configured !== undefined && configured !== "") return configured;
  return undefined;
}

/**
 * 读数值型环境变量（缺省或非法时返回 undefined，由调用方的默认值兜底）。
 *
 * 用于 `NOJ_BACKUP_RETENTION_DAYS` / `NOJ_BACKUP_MIN_FREE_MB` 的 bash 兼容缺省
 * （backup.sh:13-14）。
 */
export function envNumber(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 读一个数值旗标（非法值报用法错误）。 */
export function numberFlag(
  args: string[],
  name: string,
): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${name} 必须是非负整数，收到 "${raw}"`);
  }
  return n;
}

/** 把 `RenderIO` 从注入的 out/err 构造出来（未注入即缺省，由 render 层直写进程流）。 */
export function renderIOOf(
  deps: ProdCliDeps,
): import("../../output/render.ts").RenderIO {
  const io: import("../../output/render.ts").RenderIO = {};
  if (deps.out !== undefined) io.stdout = deps.out;
  if (deps.err !== undefined) io.stderr = deps.err;
  return io;
}
