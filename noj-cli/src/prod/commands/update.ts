/** `update` / `upgrade` 命令：版本升级接线与升级前备份装配。 */

import type { CommandRunner } from "../../runtime/command.ts";
import { flagValue, hasFlag, optionalCount } from "../../util/args.ts";
import { update, type UpdateResult } from "../lifecycle.ts";
import { createDrainLifecycle } from "../lifecycle/drain.ts";
import { runBackupCreate } from "./backup.ts";
import { envNumber, numberFlag, prodDeps, renderIOOf } from "./deps.ts";
import type { ProdCliDeps } from "./types.ts";

/**
 * `update` / `upgrade`。
 *
 * `UpdateOptions.backup` 是**必填注入点**
 * （未注入即明确失败，而不是静默跳过备份）。这里接上 `prod/backup` 的真实实现——
 * "升级前必须备份"这条门禁因此真正生效。
 */
export async function runProdUpdate(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<UpdateResult> {
  const d = prodDeps(deps);
  const passphraseFile = flagValue(args, "--passphrase-file");
  const minFreeMb = numberFlag(args, "--min-free-mb") ??
    envNumber("NOJ_BACKUP_MIN_FREE_MB");
  // P1d：自动排空（--skip-drain 显式关闭；--drain-timeout 调 wait 超时）
  const skipDrain = hasFlag(args, "--skip-drain");
  const recover = hasFlag(args, "--recover");
  const drainTimeoutSecs = optionalCount(args, "--drain-timeout");
  const warn = (message: string) =>
    (deps.err ?? ((t: string) => console.error(t)))(message);

  return await update({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    // `upgrade` 是别名，必须与 `update` 同样解析 --latest。
    latest: hasFlag(args, "--latest"),
    repository: d.processEnv["NOJ_UPDATE_REPOSITORY"],
    apiUrl: d.processEnv["NOJ_UPDATE_API_URL"],
    fetcher: deps.fetcher,
    passphraseFile,
    processEnv: d.processEnv,
    now: deps.now?.(),
    warn,
    // 升级前真实备份（未注入 → 明确失败）
    backup: (ctx) => runUpgradeBackup(d, ctx, passphraseFile, deps, minFreeMb),
    // `--files-only` 语义的部署文件同步：缺省走 downloadReleaseFiles
    syncFiles: undefined,
    // 默认排空实现：docker compose run --rm --no-deps --entrypoint … core maintain …
    drain: skipDrain ? undefined : createDrainLifecycle({
      runner: d.runner,
      dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"],
    }),
    skipDrain,
    recover,
    drainTimeoutSecs,
  });
}

/** 升级前备份的装配（`backup create` 的原生实现）。 */
async function runUpgradeBackup(
  _d: { runner: CommandRunner; processEnv: Record<string, string> },
  ctx: {
    dir: string;
    version: string;
    envFile: string;
    passphraseFile: string;
  },
  passphraseFile: string | undefined,
  deps: ProdCliDeps,
  minFreeMb: number | undefined,
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  try {
    const created = await runBackupCreate(ctx.dir, {
      passphraseFile: passphraseFile ?? ctx.passphraseFile,
      minFreeMb,
      args: [],
      deps,
    });
    return { ok: true, path: created.path, error: null };
  } catch (err) {
    return { ok: false, path: null, error: (err as Error).message };
  }
}
