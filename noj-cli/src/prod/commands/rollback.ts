/** `rollback` 命令：参数解析、用法校验与回滚生命周期装配。 */

import {
  flagValue,
  hasFlag,
  optionalCount,
  UsageError,
} from "../../util/args.ts";
import { validateReleaseTag } from "../release.ts";
import { assertContainerPath } from "../backup/commands.ts";
import { rollback, type RollbackResult } from "../lifecycle/rollback.ts";
import { createDrainLifecycle } from "../lifecycle/drain.ts";
import { positionals } from "./args.ts";
import { prodDeps, renderIOOf } from "./deps.ts";
import type { ProdCliDeps } from "./types.ts";

/** 解析并校验 `rollback` 命令参数（纯函数，可在目录定位前触发 UsageError）。 */
export interface ParsedRollbackArgs {
  to: string | undefined;
  restoreBackup: string | undefined;
  passphraseFile: string | undefined;
  noEncrypt: boolean;
  forceAppOnly: boolean;
  skipDrain: boolean;
  dryRun: boolean;
  drainTimeoutSecs: number | undefined;
}

export function parseRollbackArgs(args: string[]): ParsedRollbackArgs {
  const extraPositionals = positionals(args);
  if (extraPositionals.length > 0) {
    throw new UsageError(
      `rollback 不接受位置参数，收到 "${
        extraPositionals[0]
      }"（请使用 --to / --restore-backup）`,
    );
  }

  const to = flagValue(args, "--to");
  if (to !== undefined) {
    try {
      validateReleaseTag(to);
    } catch (err) {
      throw new UsageError(`--to 版本格式非法：${(err as Error).message}`);
    }
  }

  const restoreBackup = flagValue(args, "--restore-backup");
  if (restoreBackup !== undefined) {
    try {
      assertContainerPath(restoreBackup);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  }

  return {
    to,
    restoreBackup,
    passphraseFile: flagValue(args, "--passphrase-file"),
    noEncrypt: hasFlag(args, "--no-encrypt"),
    forceAppOnly: hasFlag(args, "--force-app-only"),
    skipDrain: hasFlag(args, "--skip-drain"),
    dryRun: hasFlag(args, "--dry-run"),
    drainTimeoutSecs: optionalCount(args, "--drain-timeout"),
  };
}

/**
 * 执行 `noj-cli rollback`。
 *
 * 参数错误（未知位置参数、非法 `--to` 版本号、非法快照路径）抛 {@link UsageError}
 * （由分发层映射为退出码 2）。
 */
export async function runProdRollback(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<RollbackResult> {
  const parsed = parseRollbackArgs(args);

  const d = prodDeps(deps);
  const warn = (message: string) =>
    (deps.err ?? ((t: string) => console.error(t)))(message);

  return await rollback({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    to: parsed.to,
    restoreBackup: parsed.restoreBackup,
    passphraseFile: parsed.passphraseFile,
    noEncrypt: parsed.noEncrypt,
    forceAppOnly: parsed.forceAppOnly,
    skipDrain: parsed.skipDrain,
    drainTimeoutSecs: parsed.drainTimeoutSecs,
    dryRun: parsed.dryRun,
    repository: d.processEnv["NOJ_UPDATE_REPOSITORY"],
    fetcher: deps.fetcher,
    processEnv: d.processEnv,
    now: deps.now?.(),
    warn,
    dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"],
    drain: parsed.skipDrain ? undefined : createDrainLifecycle({
      runner: d.runner,
      dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"],
    }),
  });
}
