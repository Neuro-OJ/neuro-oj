/**
 * 生产磁盘空间探测、数据量估算、备份/升级空间预检与告警报告。
 *
 * 所有外部命令均经注入的 {@link CommandRunner} 执行，不包含任何 bash 脚本调用，
 * 且不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { dirname } from "@std/path";
import type { CommandRunner } from "../runtime/command.ts";
import {
    postgresEnvOf,
    prodComposeArgs,
    type ProdComposeContext,
} from "./backup/driver.ts";

export const MIB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

/** 固定可用空间兜底下限默认值（MB）。 */
export const DEFAULT_BACKUP_MIN_FREE_MB = 1024;

function parseOptionalNonNegativeInt(
    raw: string | undefined,
): number | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 解析备份最低可用空间下限（MB）：旗标 > 进程环境 > `.env.prod` > 1024。 */
export function resolveBackupMinFreeMb(opts: {
    flag?: number;
    processEnv?: string;
    configured?: string;
}): number {
    return opts.flag ??
        parseOptionalNonNegativeInt(opts.processEnv) ??
        parseOptionalNonNegativeInt(opts.configured) ??
        DEFAULT_BACKUP_MIN_FREE_MB;
}

/** 备份空间安全余量（512 MiB）。 */
export const BACKUP_SAFETY_MARGIN_BYTES = 512 * MIB;

/** 保守压缩率估计（压缩后体积约为原始数据的 85%）。 */
export const BACKUP_ESTIMATED_COMPRESSION_RATIO = 0.85;

/** `update` 待拉取镜像保守预估：基础栈 1.5 GiB，含 Judge + AI 解题镜像 4.0 GiB。 */
export const UPDATE_IMAGE_PULL_BASE_BYTES = 1536 * MIB;
export const UPDATE_IMAGE_PULL_JUDGE_BYTES = 4096 * MIB;

/** `check` / `status` 磁盘告警阈值：可用 < 5 GiB 或已用 >= 85%；严重 < 1 GiB 或 >= 95%。 */
export const DISK_WARN_FREE_BYTES = 5 * GIB;
export const DISK_WARN_USED_PERCENT = 85;
export const DISK_CRITICAL_FREE_BYTES = 1 * GIB;
export const DISK_CRITICAL_USED_PERCENT = 95;

export interface DiskPartitionInfo {
    filesystem: string;
    mountPoint: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    targetPath: string;
    probedPath: string;
}

export interface BackupDataEstimate {
    postgresBytes: number | null;
    redisBytes: number | null;
    minioBytes: number | null;
    totalBytes: number;
    sources: string[];
}

export interface BackupDiskCalculation {
    requiredBytes: number;
    minFreeBytes: number;
    dataRequiredBytes: number;
}

export interface BackupDiskCheckResult {
    ok: boolean;
    skipped: boolean;
    requiredBytes: number;
    minFreeBytes: number;
    dataRequiredBytes: number;
    availableBytes: number;
    mountPoint: string | null;
    estimate: BackupDataEstimate | null;
    error: string | null;
}

export interface UpdateDiskCheckResult {
    ok: boolean;
    skipped: boolean;
    backupRequiredBytes: number;
    imagePullBytes: number;
    totalRequiredBytes: number;
    samePartition: boolean;
    backupPartition: DiskPartitionInfo | null;
    dockerPartition: DiskPartitionInfo | null;
    estimate: BackupDataEstimate | null;
    error: string | null;
}

export type DiskPartitionSeverity = "ok" | "warning" | "critical";

export interface DiskReportEntry {
    label: string;
    partition: DiskPartitionInfo;
    status: DiskPartitionSeverity;
    alert: string | null;
}

export interface DiskUsageReport {
    installDir: string;
    dockerRootDir: string | null;
    samePartition: boolean;
    entries: DiskReportEntry[];
    partitions: Array<{
        label: string;
        mountPoint: string;
        filesystem: string;
        totalBytes: number;
        usedBytes: number;
        availableBytes: number;
        usedPercent: number;
        status: DiskPartitionSeverity;
        alert: string | null;
    }>;
}

function formatNumberTrimmed(value: number, decimals: number): string {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(decimals).replace(/\.?0+$/, "");
}

/** 将字节数格式化为人类可读单位（B / KiB / MiB / GiB）。 */
export function formatDiskBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return "未知";
    const clamped = Math.max(0, bytes);
    if (clamped >= GIB) return `${formatNumberTrimmed(clamped / GIB, 2)} GiB`;
    if (clamped >= MIB) return `${formatNumberTrimmed(clamped / MIB, 1)} MiB`;
    if (clamped >= 1024) return `${formatNumberTrimmed(clamped / 1024, 1)} KiB`;
    return `${Math.round(clamped)} B`;
}

/** 解析 `df -Pk <dir>` 的 POSIX 1K 块输出。 */
export function parseDfPkOutput(
    stdout: string,
    targetPath: string,
    probedPath = targetPath,
): DiskPartitionInfo | null {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    const dataLine = lines[lines.length - 1]!;
    const cols = dataLine.split(/\s+/);
    if (cols.length < 6) return null;

    const filesystem = cols[0] ?? "";
    const totalKb = Number(cols[1]);
    const usedKb = Number(cols[2]);
    const availKb = Number(cols[3]);
    const capRaw = cols[4] ?? "";
    const mountPoint = cols.slice(5).join(" ");

    if (
        filesystem === "" ||
        mountPoint === "" ||
        !Number.isFinite(totalKb) ||
        !Number.isFinite(usedKb) ||
        !Number.isFinite(availKb) ||
        totalKb < 0 ||
        usedKb < 0 ||
        availKb < 0
    ) {
        return null;
    }

    const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(capRaw);
    const usedPercent = pctMatch !== null
        ? Number(pctMatch[1])
        : totalKb > 0
        ? Math.round((usedKb / totalKb) * 100)
        : 0;

    return {
        filesystem,
        mountPoint,
        totalBytes: totalKb * 1024,
        usedBytes: usedKb * 1024,
        availableBytes: availKb * 1024,
        usedPercent,
        targetPath,
        probedPath,
    };
}

/** 判断两个目录是否位于同一挂载分区。 */
export function samePartition(
    a: DiskPartitionInfo,
    b: DiskPartitionInfo,
): boolean {
    return a.filesystem === b.filesystem && a.mountPoint === b.mountPoint;
}

/** 解析纯非负整数字节输出（如 `SELECT pg_database_size(...)`）。 */
export function parseNonNegativeIntBytes(stdout: string): number | null {
    const trimmed = stdout.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const val = Number(trimmed);
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
}

/** 从 `redis-cli INFO memory` 输出中提取 `used_memory`（字节）。 */
export function parseRedisMemoryBytes(stdout: string): number | null {
    const normalized = stdout.replace(/\r\n/g, "\n");
    const match = /^used_memory:(\d+)\s*$/m.exec(normalized);
    if (match === null) return null;
    const val = Number(match[1]);
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
}

const SIZE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
    b: 1,
    kib: 1024,
    k: 1024,
    mib: MIB,
    m: MIB,
    gib: GIB,
    g: GIB,
    tib: 1024 * GIB,
    t: 1024 * GIB,
    kb: 1000,
    mb: 1000 * 1000,
    gb: 1000 * 1000 * 1000,
    tb: 1000 * 1000 * 1000 * 1000,
};

/** 解析 `mc du --json`（或人类单位文本兜底）的桶总字节数。 */
export function parseMcDuBytes(stdout: string): number | null {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    const jsonSizes: Array<{ size: number; status?: string }> = [];
    let allJson = true;
    for (const line of lines) {
        try {
            const obj = JSON.parse(line) as {
                size?: unknown;
                status?: unknown;
            };
            if (
                typeof obj === "object" &&
                obj !== null &&
                typeof obj.size === "number" &&
                Number.isFinite(obj.size) &&
                obj.size >= 0
            ) {
                jsonSizes.push({
                    size: obj.size,
                    status: typeof obj.status === "string"
                        ? obj.status
                        : undefined,
                });
            } else {
                allJson = false;
            }
        } catch {
            allJson = false;
        }
    }

    if (jsonSizes.length > 0 && allJson) {
        const succeeded = jsonSizes.filter((entry) =>
            entry.status === "success"
        );
        const target = succeeded.length > 0 ? succeeded : jsonSizes;
        return target.reduce((sum, entry) => sum + entry.size, 0);
    }

    // 文本输出回退（例如 `1.5GiB  42 objects`）
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\b/.exec(lines[i]!);
        if (m === null) continue;
        const num = Number(m[1]);
        const mult = SIZE_UNIT_MULTIPLIERS[m[2]!.toLowerCase()];
        if (Number.isFinite(num) && num >= 0 && mult !== undefined) {
            return Math.ceil(num * mult);
        }
    }
    return null;
}

/** 计算备份所需的最低磁盘可用字节数（固定下限兜底 + 按数据量估算峰值）。 */
export function calculateBackupRequiredBytes(opts: {
    rawDataBytes: number;
    minFreeMb: number;
    streaming?: boolean;
    compressionRatio?: number;
    marginBytes?: number;
}): BackupDiskCalculation {
    const minFreeBytes = Math.max(0, opts.minFreeMb) * MIB;
    const raw = Math.max(0, opts.rawDataBytes);
    if (raw <= 0) {
        return {
            requiredBytes: minFreeBytes,
            minFreeBytes,
            dataRequiredBytes: 0,
        };
    }
    const ratio = opts.compressionRatio ?? BACKUP_ESTIMATED_COMPRESSION_RATIO;
    const margin = opts.marginBytes ?? BACKUP_SAFETY_MARGIN_BYTES;
    const multiplier = opts.streaming === false ? 2 : 1;
    const compressed = Math.ceil(raw * ratio);
    const dataRequiredBytes = raw + compressed * multiplier + margin;
    return {
        requiredBytes: Math.max(minFreeBytes, dataRequiredBytes),
        minFreeBytes,
        dataRequiredBytes,
    };
}

function formatEstimateBreakdown(estimate: BackupDataEstimate | null): string {
    if (estimate === null || estimate.totalBytes <= 0) return "";
    const parts: string[] = [];
    if (estimate.postgresBytes !== null) {
        parts.push(`PG ${formatDiskBytes(estimate.postgresBytes)}`);
    }
    if (estimate.redisBytes !== null) {
        parts.push(`Redis ${formatDiskBytes(estimate.redisBytes)}`);
    }
    if (estimate.minioBytes !== null) {
        parts.push(`MinIO ${formatDiskBytes(estimate.minioBytes)}`);
    }
    return parts.length > 0 ? `（含原始数据 ${parts.join(" + ")}）` : "";
}

/** 评估备份目录空间是否满足需求。 */
export function evaluateBackupDiskSpace(opts: {
    partition?: DiskPartitionInfo | null;
    availableBytes?: number;
    minFreeMb: number;
    estimate: BackupDataEstimate | null;
    streaming?: boolean;
}): BackupDiskCheckResult {
    const availableBytes =
        opts.partition !== undefined && opts.partition !== null
            ? opts.partition.availableBytes
            : (opts.availableBytes ?? Number.POSITIVE_INFINITY);
    const mountPoint = opts.partition?.mountPoint ?? null;
    const calc = calculateBackupRequiredBytes({
        rawDataBytes: opts.estimate?.totalBytes ?? 0,
        minFreeMb: opts.minFreeMb,
        streaming: opts.streaming,
    });

    if (!Number.isFinite(availableBytes)) {
        return {
            ok: true,
            skipped: true,
            ...calc,
            availableBytes,
            mountPoint,
            estimate: opts.estimate,
            error: null,
        };
    }

    if (availableBytes < calc.requiredBytes) {
        const mountNote = mountPoint !== null ? `（挂载点 ${mountPoint}）` : "";
        const detail = formatEstimateBreakdown(opts.estimate);
        const error = `备份目录可用空间不足${mountNote}：需要 ${
            formatDiskBytes(calc.requiredBytes)
        }${detail} / 可用 ${formatDiskBytes(availableBytes)}（兜底下限 ${
            formatDiskBytes(calc.minFreeBytes)
        }）`;
        return {
            ok: false,
            skipped: false,
            ...calc,
            availableBytes,
            mountPoint,
            estimate: opts.estimate,
            error,
        };
    }

    return {
        ok: true,
        skipped: false,
        ...calc,
        availableBytes,
        mountPoint,
        estimate: opts.estimate,
        error: null,
    };
}

/** 评估 `update` 整体所需磁盘空间（备份峰值 + 待拉取镜像预估，自动区分同/异分区）。 */
export function evaluateUpdateDiskSpace(opts: {
    backupPartition: DiskPartitionInfo | null;
    dockerPartition: DiskPartitionInfo | null;
    minFreeMb: number;
    estimate: BackupDataEstimate | null;
    judgeEnabled: boolean;
    streaming?: boolean;
    imagePullBytes?: number;
}): UpdateDiskCheckResult {
    const imagePullBytes = opts.imagePullBytes ??
        (opts.judgeEnabled
            ? UPDATE_IMAGE_PULL_JUDGE_BYTES
            : UPDATE_IMAGE_PULL_BASE_BYTES);
    const calc = calculateBackupRequiredBytes({
        rawDataBytes: opts.estimate?.totalBytes ?? 0,
        minFreeMb: opts.minFreeMb,
        streaming: opts.streaming,
    });
    const backupRequiredBytes = calc.requiredBytes;
    const totalRequiredBytes = backupRequiredBytes + imagePullBytes;

    const { backupPartition, dockerPartition } = opts;
    if (backupPartition === null && dockerPartition === null) {
        return {
            ok: true,
            skipped: true,
            backupRequiredBytes,
            imagePullBytes,
            totalRequiredBytes,
            samePartition: true,
            backupPartition: null,
            dockerPartition: null,
            estimate: opts.estimate,
            error: null,
        };
    }

    // Docker 根目录未探测出或两路径在同一分区时，合并在同一分区校验总需求
    const shared = backupPartition !== null && dockerPartition !== null
        ? samePartition(backupPartition, dockerPartition)
        : backupPartition !== null;

    if (shared && backupPartition !== null) {
        if (backupPartition.availableBytes < totalRequiredBytes) {
            const detail = formatEstimateBreakdown(opts.estimate);
            return {
                ok: false,
                skipped: false,
                backupRequiredBytes,
                imagePullBytes,
                totalRequiredBytes,
                samePartition: true,
                backupPartition,
                dockerPartition,
                estimate: opts.estimate,
                error:
                    `升级前磁盘可用空间不足（挂载点 ${backupPartition.mountPoint}）：需要 ${
                        formatDiskBytes(totalRequiredBytes)
                    }（备份峰值 ${
                        formatDiskBytes(backupRequiredBytes)
                    }${detail} + 镜像拉取预估 ${
                        formatDiskBytes(imagePullBytes)
                    }）/ 可用 ${
                        formatDiskBytes(backupPartition.availableBytes)
                    }`,
            };
        }
        return {
            ok: true,
            skipped: false,
            backupRequiredBytes,
            imagePullBytes,
            totalRequiredBytes,
            samePartition: true,
            backupPartition,
            dockerPartition,
            estimate: opts.estimate,
            error: null,
        };
    }

    // 异分区场景（或仅能探测到 Docker 分区）：分别校验
    const problems: string[] = [];
    if (
        backupPartition !== null &&
        backupPartition.availableBytes < backupRequiredBytes
    ) {
        const detail = formatEstimateBreakdown(opts.estimate);
        problems.push(
            `备份目录分区（${backupPartition.mountPoint}）需要 ${
                formatDiskBytes(backupRequiredBytes)
            }${detail} / 可用 ${
                formatDiskBytes(backupPartition.availableBytes)
            }`,
        );
    }
    if (
        dockerPartition !== null &&
        dockerPartition.availableBytes < imagePullBytes
    ) {
        problems.push(
            `Docker 数据目录分区（${dockerPartition.mountPoint}）需要镜像预估 ${
                formatDiskBytes(imagePullBytes)
            } / 可用 ${formatDiskBytes(dockerPartition.availableBytes)}`,
        );
    }

    return {
        ok: problems.length === 0,
        skipped: false,
        backupRequiredBytes,
        imagePullBytes,
        totalRequiredBytes,
        samePartition: false,
        backupPartition,
        dockerPartition,
        estimate: opts.estimate,
        error: problems.length > 0
            ? `升级前磁盘可用空间不足：${problems.join("；")}`
            : null,
    };
}

/** 向上查找已存在的祖先目录，确保尚不存在的 `backups/` 也能经 `df -Pk` 探测分区。 */
export async function resolveExistingAncestor(path: string): Promise<string> {
    let current = path;
    for (;;) {
        const st = await Deno.stat(current).catch(() => null);
        if (st !== null) return st.isDirectory ? current : dirname(current);
        const parent = dirname(current);
        if (parent === current) return current;
        current = parent;
    }
}

/** 探测目录所在分区的磁盘空间；不可探测时返回 `null`（不误阻断）。 */
export async function probeDiskPartition(
    runner: CommandRunner,
    dir: string,
): Promise<DiskPartitionInfo | null> {
    try {
        const probed = await resolveExistingAncestor(dir);
        const res = await runner.run("df", ["-Pk", probed]);
        if (res.code !== 0) return null;
        return parseDfPkOutput(res.stdout, dir, probed);
    } catch {
        return null;
    }
}

/** 探测 Docker 数据根目录（`docker info --format '{{.DockerRootDir}}'`）。 */
export async function probeDockerRootDir(
    runner: CommandRunner,
    dockerBin = "docker",
): Promise<string | null> {
    try {
        const res = await runner.run(dockerBin, [
            "info",
            "--format",
            "{{.DockerRootDir}}",
        ]);
        if (res.code !== 0) return null;
        const trimmed = res.stdout.trim();
        return trimmed.startsWith("/") ? trimmed : null;
    } catch {
        return null;
    }
}

/**
 * 估算当前生产实例 PostgreSQL / Redis / MinIO 的原始数据量（只读查询）。
 *
 * 任一组件未运行或探测失败时记为 `null` 并继续估算其余组件，不中断主流程。
 */
export async function estimateBackupDataSize(opts: {
    runner: CommandRunner;
    compose: ProdComposeContext;
    env: Record<string, string | undefined>;
}): Promise<BackupDataEstimate> {
    const { runner, compose, env } = opts;
    const pg = postgresEnvOf(env);
    const bucket = env["S3_BUCKET"] || "noj-support-packages";

    const postgresBytes = await (async (): Promise<number | null> => {
        try {
            const res = await runner.run(
                compose.dockerBin,
                prodComposeArgs(compose, [
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-U",
                    pg.user,
                    "-d",
                    pg.db,
                    "-Atqc",
                    "SELECT pg_database_size(current_database())",
                ]),
            );
            return res.code === 0 ? parseNonNegativeIntBytes(res.stdout) : null;
        } catch {
            return null;
        }
    })();

    const redisBytes = await (async (): Promise<number | null> => {
        try {
            const res = await runner.run(
                compose.dockerBin,
                prodComposeArgs(compose, [
                    "exec",
                    "-T",
                    "redis",
                    "sh",
                    "-c",
                    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning INFO memory',
                ]),
            );
            return res.code === 0 ? parseRedisMemoryBytes(res.stdout) : null;
        } catch {
            return null;
        }
    })();

    const minioBytes = await (async (): Promise<number | null> => {
        try {
            const res = await runner.run(
                compose.dockerBin,
                prodComposeArgs(compose, [
                    "run",
                    "--rm",
                    "--no-deps",
                    "--env",
                    "MC_CONFIG_DIR=/tmp/noj-backup-mc",
                    "--entrypoint",
                    "/bin/sh",
                    "minio-init",
                    "-c",
                    'set -eu; mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc du --json "local/$1"',
                    "noj-mc-du",
                    bucket,
                ]),
            );
            return res.code === 0 ? parseMcDuBytes(res.stdout) : null;
        } catch {
            return null;
        }
    })();

    const sources: string[] = [];
    let totalBytes = 0;
    if (postgresBytes !== null) {
        sources.push("PostgreSQL");
        totalBytes += postgresBytes;
    }
    if (redisBytes !== null) {
        sources.push("Redis");
        totalBytes += redisBytes;
    }
    if (minioBytes !== null) {
        sources.push("MinIO");
        totalBytes += minioBytes;
    }

    return { postgresBytes, redisBytes, minioBytes, totalBytes, sources };
}

/** 判定单个分区的告警级别与提示文案。 */
export function classifyPartitionSeverity(
    partition: DiskPartitionInfo,
): { status: DiskPartitionSeverity; alert: string | null } {
    if (
        partition.availableBytes < DISK_CRITICAL_FREE_BYTES ||
        partition.usedPercent >= DISK_CRITICAL_USED_PERCENT
    ) {
        return {
            status: "critical",
            alert: `空间严重不足（可用 < ${
                formatDiskBytes(DISK_CRITICAL_FREE_BYTES)
            } 或使用率 ≥ ${DISK_CRITICAL_USED_PERCENT}%），请先清理再执行备份或升级`,
        };
    }
    if (
        partition.availableBytes < DISK_WARN_FREE_BYTES ||
        partition.usedPercent >= DISK_WARN_USED_PERCENT
    ) {
        return {
            status: "warning",
            alert: `可用空间偏低（可用 < ${
                formatDiskBytes(DISK_WARN_FREE_BYTES)
            } 或使用率 ≥ ${DISK_WARN_USED_PERCENT}%）`,
        };
    }
    return { status: "ok", alert: null };
}

/** 探测安装目录与 Docker 数据目录分区的余量报告；均不可探测时返回 `null`。 */
export async function probeDiskUsageReport(opts: {
    runner: CommandRunner;
    installDir: string;
    dockerBin?: string;
}): Promise<DiskUsageReport | null> {
    const installPartition = await probeDiskPartition(
        opts.runner,
        opts.installDir,
    );
    const dockerRootDir = await probeDockerRootDir(opts.runner, opts.dockerBin);
    const dockerPartition = dockerRootDir !== null
        ? await probeDiskPartition(opts.runner, dockerRootDir)
        : null;

    if (installPartition === null && dockerPartition === null) return null;

    const same = installPartition !== null && dockerPartition !== null &&
        samePartition(installPartition, dockerPartition);
    const rawEntries: Array<{ label: string; partition: DiskPartitionInfo }> =
        [];

    if (same && installPartition !== null) {
        rawEntries.push({
            label: "安装目录 / Docker 数据目录",
            partition: installPartition,
        });
    } else {
        if (installPartition !== null) {
            rawEntries.push({ label: "安装目录", partition: installPartition });
        }
        if (dockerPartition !== null) {
            rawEntries.push({
                label: "Docker 数据目录",
                partition: dockerPartition,
            });
        }
    }

    const entries: DiskReportEntry[] = rawEntries.map((item) => {
        const { status, alert } = classifyPartitionSeverity(item.partition);
        return { ...item, status, alert };
    });

    return {
        installDir: opts.installDir,
        dockerRootDir,
        samePartition: same,
        entries,
        partitions: entries.map((entry) => ({
            label: entry.label,
            mountPoint: entry.partition.mountPoint,
            filesystem: entry.partition.filesystem,
            totalBytes: entry.partition.totalBytes,
            usedBytes: entry.partition.usedBytes,
            availableBytes: entry.partition.availableBytes,
            usedPercent: entry.partition.usedPercent,
            status: entry.status,
            alert: entry.alert,
        })),
    };
}

/** 格式化人类可读的分区磁盘余量与告警行。 */
export function formatDiskReportLines(report: DiskUsageReport): string[] {
    return report.entries.map((entry) => {
        const p = entry.partition;
        const base =
            `磁盘空间（${entry.label}，挂载点 ${p.mountPoint}）：可用 ${
                formatDiskBytes(p.availableBytes)
            } / 总计 ${
                formatDiskBytes(p.totalBytes)
            }（已用 ${p.usedPercent}%）`;
        return entry.alert === null ? base : `${base} —— 告警：${entry.alert}`;
    });
}
