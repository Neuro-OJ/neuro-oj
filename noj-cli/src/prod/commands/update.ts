/** `update` / `upgrade` 命令：版本升级接线与升级前备份装配。 */

import type { CommandRunner } from "../../runtime/command.ts";
import { update, type UpdateResult } from "../lifecycle.ts";
import { createDrainLifecycle } from "../lifecycle/drain.ts";
import { flagValue, hasFlag, optionalCount } from "./args.ts";
import { prodDeps, renderIOOf } from "./deps.ts";
import { runBackupCreate } from "./backup.ts";
import type { ProdCliDeps } from "./types.ts";

/**
 * `update` / `upgrade`（T16）。
 *
 * **接线 T16 登记的 carry-forward**：`UpdateOptions.backup` 是**必填注入点**
 * （未注入即明确失败，而不是静默跳过备份）。这里接上 `prod/backup` 的真实实现——
 * "升级前必须备份"这条门禁因此真正生效。
 */
export async function runProdUpdate(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
  upgradeAlias = false,
): Promise<UpdateResult> {
  const d = prodDeps(deps);
  const passphraseFile = flagValue(args, "--passphrase-file");
  // P1d：自动排空（--skip-drain 显式关闭；--drain-timeout 调 wait 超时）
  const skipDrain = hasFlag(args, "--skip-drain");
  const recover = hasFlag(args, "--recover");
  const drainTimeoutSecs = optionalCount(args, "--drain-timeout");
  return await update({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    latest: upgradeAlias ? false : hasFlag(args, "--latest"),
    repository: d.processEnv["NOJ_UPDATE_REPOSITORY"],
    apiUrl: d.processEnv["NOJ_UPDATE_API_URL"],
    fetcher: deps.fetcher,
    passphraseFile,
    processEnv: d.processEnv,
    now: deps.now?.(),
    warn: (message) => (deps.err ?? ((t: string) => console.error(t)))(message),
    // T16 的注入点：真实备份（此前留空 → 明确失败）
    backup: (ctx) => runUpgradeBackup(d, ctx, passphraseFile, deps),
    // `--files-only` 语义的部署文件同步：缺省走 T9 downloadReleaseFiles
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
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  try {
    const created = await runBackupCreate(ctx.dir, {
      passphraseFile: passphraseFile ?? ctx.passphraseFile,
      args: [],
      deps,
    });
    return { ok: true, path: created.path, error: null };
  } catch (err) {
    return { ok: false, path: null, error: (err as Error).message };
  }
}
