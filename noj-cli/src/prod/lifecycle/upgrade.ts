/**
 * 生产升级编排。
 *
 * 与生命周期命令共享 `lifecycle.ts` 的目标配置和前置校验，但将升级的发布集、
 * checkpoint、迁移和排空逻辑单独放置，避免生命周期入口继续膨胀。
 */
import { join } from "@std/path";
import { downloadReleaseFiles, downloadReleaseSet } from "../bootstrap.ts";
import { composePull, composeRun } from "../compose.ts";
import { recordDeploymentMetadata, verifyImageSignatures } from "../config.ts";
import { resolveLatestReleaseTag } from "../release.ts";
import {
  readReleaseSet,
  RELEASE_SET_ASSET,
  releaseSetDigestMismatches,
  validateReleaseSet,
} from "../release-set.ts";
import type { ReleaseSet } from "../release-set.ts";
import {
  advanceUpgradeState,
  createUpgradeState,
  upgradeStatePath,
  writeUpgradeState,
} from "../upgrade-state.ts";
import type { UpgradeState } from "../upgrade-state.ts";
import { emitHuman } from "../../output/render.ts";
import {
  composeOutputText,
  ensureCommandPassphrase,
  runComposeSub,
  WAIT_FAILURE_HINT,
  waitForStack,
} from "./steps.ts";
import { drainAfterUpgrade, drainBeforeUpgrade } from "./drain.ts";
import { resolveTargetConfig } from "./target.ts";
import { prepareLifecycle, probeCosign } from "../lifecycle.ts";
import type { ResolvedTargetConfig } from "./target.ts";
import type {
  LifecycleContext,
  UpdateBackupContext,
  UpdateBackupResult,
  UpdateOptions,
  UpdateSyncContext,
} from "../lifecycle.ts";

/** `--latest`：解析最新稳定 Release 的目标版本。 */
export async function resolveLatestTarget(
  opts: UpdateOptions,
): Promise<string> {
  return await resolveLatestReleaseTag({
    repository: opts.repository,
    apiUrl: opts.apiUrl,
    fetcher: opts.fetcher,
  });
}

/** 升级前备份：未接线时明确失败，绝不静默跳过。 */
export async function runUpdateBackup(
  opts: UpdateOptions,
  context: UpdateBackupContext,
): Promise<UpdateBackupResult> {
  if (opts.backup === undefined) {
    return {
      ok: false,
      path: null,
      error:
        "升级前备份尚未接线（备份子系统由 T17–T19 交付）；为安全起见已中止升级",
    };
  }
  return await opts.backup(context);
}

/** 同步 compose、环境模板和同版本发布集资产。 */
export async function runUpdateSync(
  opts: UpdateOptions,
  context: UpdateSyncContext,
): Promise<void> {
  if (opts.syncFiles !== undefined) {
    await opts.syncFiles(context);
    return;
  }
  await downloadReleaseFiles({
    repository: context.repository,
    ref: context.ref,
    targetDir: context.dir,
    overwrite: true,
    fetcher: opts.fetcher,
  });
  await downloadReleaseSet({
    repository: context.repository,
    ref: context.ref,
    targetDir: context.dir,
    overwrite: true,
    fetcher: opts.fetcher,
  });
}

/** 读取并绑定本次升级的发布集；测试注入 syncFiles 时不假造资产。 */
async function loadTargetReleaseSet(
  opts: UpdateOptions,
  ctx: LifecycleContext,
  target: ResolvedTargetConfig,
): Promise<ReleaseSet | null> {
  if (opts.releaseSet !== undefined) {
    return validateReleaseSet(opts.releaseSet, target.version);
  }
  if (opts.syncFiles !== undefined) return null;
  return await readReleaseSet(join(ctx.dir, RELEASE_SET_ASSET), target.version);
}

/** 显式执行 Core → Gateway 一次性迁移，迁移成功后才启动目标栈。 */
async function runUpdateMigrations(
  opts: UpdateOptions,
  ctx: LifecycleContext,
  target: ResolvedTargetConfig,
): Promise<string | null> {
  if (opts.migrate !== undefined) {
    await opts.migrate({ dir: ctx.dir, target });
    return null;
  }
  const services = ["core", "ui", "llm-gateway", "nginx"];
  if (target.judge) services.splice(2, 0, "judge");
  const stopped = await runComposeSub(opts.runner, target.composeOptions, [
    "stop",
    ...services,
  ]);
  const stoppedText = composeOutputText(stopped);
  if (stoppedText !== "") emitHuman(stoppedText, ctx.io);
  if (!Array.isArray(stopped) && stopped.code !== 0) {
    return "停止旧应用服务以执行迁移失败：" +
      (stopped.stderr.trim() || `docker compose 退出码 ${stopped.code}`);
  }
  for (const service of ["migrate", "gateway-migrate"]) {
    const migration = await composeRun(
      opts.runner,
      target.composeOptions,
      service,
    );
    const migrationText = composeOutputText(migration);
    if (migrationText !== "") emitHuman(migrationText, ctx.io);
    if (!Array.isArray(migration) && migration.code !== 0) {
      return `${service} 迁移失败：${
        migration.stderr.trim() || `docker compose 退出码 ${migration.code}`
      }`;
    }
  }
  return null;
}

export interface UpgradeOutcome {
  error: string | null;
  backupPath: string | null;
  drainExitError?: string | null;
  checkpointPath?: string;
}

/** 升级编排：发布集、备份、验签、排空、迁移、启动和 checkpoint 顺序固定。 */
export async function upgradeWith(
  opts: UpdateOptions,
  ctx: LifecycleContext,
  stagedEnvFile?: string,
): Promise<UpgradeOutcome> {
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) return { error: prepared.error, backupPath: null };

  const plan = await resolveTargetConfig(prepared, stagedEnvFile);
  if (!plan.ok) {
    ctx.error(plan.error);
    return { error: plan.error, backupPath: null };
  }
  const target = plan.target;

  let releaseSet: ReleaseSet | null;
  try {
    releaseSet = await loadTargetReleaseSet(opts, ctx, target);
  } catch (error) {
    const message = (error as Error).message;
    ctx.error(message);
    return { error: message, backupPath: null };
  }

  const checkpointPath = opts.upgradeStatePath ?? upgradeStatePath(ctx.dir);
  let checkpoint: UpgradeState;
  try {
    checkpoint = createUpgradeState({
      runId: crypto.randomUUID(),
      from: prepared.env["NOJ_VERSION"] ?? "",
      to: target.version,
      releaseSetRelease: releaseSet?.release ?? null,
      now: opts.now,
    });
    await writeUpgradeState(checkpointPath, checkpoint);
  } catch (error) {
    const message = `无法创建升级 checkpoint：${(error as Error).message}`;
    ctx.error(message);
    return { error: message, backupPath: null };
  }

  const checkpointAdvance = async (
    phase: UpgradeState["phase"],
    patch: Partial<
      Pick<UpgradeState, "backup_path" | "release_set_release" | "error">
    > = {},
  ): Promise<void> => {
    checkpoint = advanceUpgradeState(
      checkpoint,
      phase,
      patch,
      opts.now ?? new Date(),
    );
    await writeUpgradeState(checkpointPath, checkpoint);
  };
  const checkpointFailure = async (
    error: string,
    backupPath: string | null,
  ): Promise<UpgradeOutcome> => {
    try {
      if (checkpoint.phase !== "failed") {
        checkpoint = advanceUpgradeState(
          checkpoint,
          "failed",
          { backup_path: backupPath, error },
          opts.now ?? new Date(),
        );
        await writeUpgradeState(checkpointPath, checkpoint);
      }
    } catch (stateError) {
      ctx.error(
        `升级失败且无法写入 checkpoint：${(stateError as Error).message}`,
      );
    }
    ctx.error(error);
    return { error, backupPath, checkpointPath };
  };

  const passphrase = await ensureCommandPassphrase({
    envFile: target.envFile,
    env: target.env,
    processEnv: opts.processEnv ?? Deno.env.toObject(),
    passphraseFile: opts.passphraseFile,
    warn: opts.warn,
  });
  if (passphrase.error !== null) {
    return await checkpointFailure(passphrase.error, null);
  }
  target.env = passphrase.env;

  const backup = await runUpdateBackup(opts, {
    dir: ctx.dir,
    version: target.version,
    envFile: target.envFile,
    passphraseFile: passphrase.path,
  });
  if (!backup.ok) {
    return await checkpointFailure(backup.error ?? "升级前备份失败", null);
  }
  await checkpointAdvance("backed_up", { backup_path: backup.path });

  emitHuman("\n== 拉取目标版本镜像 ==\n", ctx.io);
  const pulled = await composePull(opts.runner, target.composeOptions);
  const pullText = composeOutputText(pulled);
  if (pullText !== "") emitHuman(pullText, ctx.io);
  if (!Array.isArray(pulled) && pulled.code !== 0) {
    return await checkpointFailure(
      "拉取生产镜像失败：" +
        (pulled.stderr.trim() || `docker compose 退出码 ${pulled.code}`),
      backup.path,
    );
  }
  await checkpointAdvance("pulled");

  const verify = await verifyImageSignatures(target.env, {
    runner: opts.runner,
    cosignAvailable: opts.cosignAvailable ??
      probeCosign(opts.runner, opts.cosignBin ?? "cosign"),
    dockerBin: opts.dockerBin,
    cosignBin: opts.cosignBin,
    warn: opts.warn,
  });
  if (!verify.ok) {
    return await checkpointFailure(
      verify.error ?? "生产镜像签名校验失败",
      backup.path,
    );
  }
  if (releaseSet !== null && !verify.skipped) {
    const mismatches = releaseSetDigestMismatches(
      releaseSet,
      verify.digests,
      target.judge,
    );
    if (mismatches.length > 0) {
      return await checkpointFailure(
        `发布集与已验签镜像不一致：${mismatches.join("；")}`,
        backup.path,
      );
    }
  }
  await checkpointAdvance("verified");

  await checkpointAdvance("draining");
  const drainError = await drainBeforeUpgrade(opts, target, ctx);
  if (drainError !== null) {
    return await checkpointFailure(drainError, backup.path);
  }

  await checkpointAdvance("migrating");
  let migrationError: string | null;
  try {
    migrationError = await runUpdateMigrations(opts, ctx, target);
  } catch (error) {
    migrationError = (error as Error).message;
  }
  if (migrationError !== null) {
    return await checkpointFailure(migrationError, backup.path);
  }

  const wait = await waitForStack(
    opts.runner,
    target.composeOptions,
    (text) => emitHuman(text, ctx.io),
  );
  if (!wait.ok) {
    let error = wait.error ?? WAIT_FAILURE_HINT;
    const drainExitError = await drainAfterUpgrade(opts, target, ctx);
    if (drainExitError !== null) {
      ctx.error(drainExitError);
      error += "\n" + drainExitError;
    }
    return await checkpointFailure(error, backup.path);
  }
  await checkpointAdvance("started");

  const drainExitError = await drainAfterUpgrade(opts, target, ctx);
  try {
    await recordDeploymentMetadata({
      version: target.version,
      at: opts.now ?? new Date(),
      verified: verify.digests,
      backupDir: join(ctx.dir, "backups"),
    });
  } catch (error) {
    return await checkpointFailure(
      `记录部署元数据失败：${(error as Error).message}`,
      backup.path,
    );
  }
  if (drainExitError !== null) {
    await checkpointFailure(drainExitError, backup.path);
  }
  return {
    error: null,
    backupPath: backup.path,
    drainExitError,
    checkpointPath,
  };
}
