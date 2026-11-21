/** `update` / `upgrade` 命令：版本升级接线与升级前备份装配。 */

import { join } from "@std/path";
import type { CommandRunner } from "../../runtime/command.ts";
import { readEnvValuesOrEmpty } from "../../core/env-file.ts";
import { flagValue, hasFlag, optionalCount } from "../../util/args.ts";
import { prodBackupDir } from "../backup/commands.ts";
import { checkAndCleanStaleBackupArtifacts } from "../backup/stale-cleanup.ts";
import { PROD_COMPOSE_FILE } from "../compose.ts";
import { judgeEnabledFrom } from "../config/checks.ts";
import {
    type BackupDataEstimate,
    type DiskPartitionInfo,
    estimateBackupDataSize,
    evaluateUpdateDiskSpace,
    formatDiskBytes,
    probeDiskPartition,
    probeDockerRootDir,
    resolveBackupMinFreeMb,
} from "../disk-space.ts";
import {
    update,
    type UpdateDiskCheckContext,
    type UpdateDiskCheckResult,
    type UpdateResult,
} from "../lifecycle.ts";
import { createDrainLifecycle } from "../lifecycle/drain.ts";
import { buildBackupComposeContext, runBackupCreate } from "./backup.ts";
import { numberFlag, prodDeps, renderIOOf } from "./deps.ts";
import type { ProdCliDeps } from "./types.ts";

/** {@link createUpdateDiskChecker} 的可注入选项。 */
export interface UpdateDiskCheckerOptions {
    minFreeMb?: number;
    runner: CommandRunner;
    processEnv: Record<string, string | undefined>;
    dockerBin?: string;
    streaming?: boolean;
    imagePullBytes?: number;
    warn?: (text: string) => void;
    probePartition?: (dir: string) => Promise<DiskPartitionInfo | null>;
    probeDockerRootDir?: () => Promise<string | null>;
    estimateDataSize?: () => Promise<BackupDataEstimate | null>;
    isProcessAlive?: (pid: number) => Promise<boolean>;
    onEstimate?: (estimate: BackupDataEstimate | null) => void;
}

/**
 * 构造 `update` 升级前磁盘空间检查器：
 *
 * 1. 先检查活跃备份锁并清理崩溃残留（释放被占空间）；
 * 2. 分别探测备份目录所在分区与 Docker 数据根目录所在分区（同分区合并、异分区分开）；
 * 3. 先按静态下限 + 镜像拉取预估做零 compose 预判；通过后再采样 PG/Redis/MinIO 数据量，
 *    并将估算结果回传缓存供随后的升级前备份复用。
 */
export function createUpdateDiskChecker(
    opts: UpdateDiskCheckerOptions,
): (ctx: UpdateDiskCheckContext) => Promise<UpdateDiskCheckResult> {
    return async (
        ctx: UpdateDiskCheckContext,
    ): Promise<UpdateDiskCheckResult> => {
        const env = await readEnvValuesOrEmpty(ctx.envFile);
        const judgeEnabled = judgeEnabledFrom(env);
        const minFreeMb = resolveBackupMinFreeMb({
            flag: opts.minFreeMb,
            processEnv: opts.processEnv["NOJ_BACKUP_MIN_FREE_MB"],
            configured: env["NOJ_BACKUP_MIN_FREE_MB"],
        });
        const backupDir = prodBackupDir(ctx.dir);
        const dockerBin = opts.dockerBin ??
            opts.processEnv["NOJ_DEPLOY_DOCKER_BIN"] ??
            "docker";
        const streaming = opts.streaming ?? (opts.runner.pipe !== undefined);

        const cleaned = await checkAndCleanStaleBackupArtifacts(backupDir, {
            runner: opts.runner,
            isProcessAlive: opts.isProcessAlive,
        });
        if (cleaned.removedStaleLock || cleaned.removed.length > 0) {
            opts.warn?.(
                `✓ 升级预检已清理备份崩溃残留（释放 ${
                    formatDiskBytes(cleaned.reclaimedBytes)
                }，移除 ${cleaned.removed.length} 项临时产物）`,
            );
        }

        const probePart = opts.probePartition ??
            ((targetDir: string) => probeDiskPartition(opts.runner, targetDir));
        const backupPartition = await probePart(backupDir);
        const dockerRootDir = opts.probeDockerRootDir !== undefined
            ? await opts.probeDockerRootDir()
            : await probeDockerRootDir(opts.runner, dockerBin);
        const dockerPartition = dockerRootDir !== null
            ? await probePart(dockerRootDir)
            : null;

        if (backupPartition === null && dockerPartition === null) {
            return { ok: true };
        }

        const baseline = evaluateUpdateDiskSpace({
            backupPartition,
            dockerPartition,
            minFreeMb,
            estimate: null,
            judgeEnabled,
            streaming,
            imagePullBytes: opts.imagePullBytes,
        });
        if (!baseline.ok) {
            return { ok: false, error: baseline.error };
        }

        const estimate = opts.estimateDataSize !== undefined
            ? await opts.estimateDataSize()
            : await estimateBackupDataSize({
                runner: opts.runner,
                compose: buildBackupComposeContext(
                    join(ctx.dir, PROD_COMPOSE_FILE),
                    ctx.envFile,
                    opts.processEnv,
                ),
                env,
            });
        opts.onEstimate?.(estimate);

        const full = evaluateUpdateDiskSpace({
            backupPartition,
            dockerPartition,
            minFreeMb,
            estimate,
            judgeEnabled,
            streaming,
            imagePullBytes: opts.imagePullBytes,
        });
        return full.ok ? { ok: true } : { ok: false, error: full.error };
    };
}

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
    const minFreeMb = numberFlag(args, "--min-free-mb");
    // P1d：自动排空（--skip-drain 显式关闭；--drain-timeout 调 wait 超时）
    const skipDrain = hasFlag(args, "--skip-drain");
    const recover = hasFlag(args, "--recover");
    const drainTimeoutSecs = optionalCount(args, "--drain-timeout");
    const warn = (message: string) =>
        (deps.err ?? ((t: string) => console.error(t)))(message);
    let cachedEstimate: BackupDataEstimate | null | undefined = undefined;

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
        checkDiskSpace: createUpdateDiskChecker({
            minFreeMb,
            runner: d.runner,
            processEnv: d.processEnv,
            dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"],
            warn,
            onEstimate: (estimate) => {
                cachedEstimate = estimate;
            },
        }),
        // 升级前真实备份（未注入 → 明确失败）
        backup: (ctx) =>
            runUpgradeBackup(
                d,
                ctx,
                passphraseFile,
                deps,
                minFreeMb,
                cachedEstimate,
            ),
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
    precomputedEstimate?: BackupDataEstimate | null,
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
    try {
        const created = await runBackupCreate(ctx.dir, {
            passphraseFile: passphraseFile ?? ctx.passphraseFile,
            minFreeMb,
            precomputedEstimate,
            args: [],
            deps,
        });
        return { ok: true, path: created.path, error: null };
    } catch (err) {
        return { ok: false, path: null, error: (err as Error).message };
    }
}
