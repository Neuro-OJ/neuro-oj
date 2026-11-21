/**
 * 备份并发锁与崩溃残留清理：在 `backup create` / `update` 空间预检前执行。
 *
 * 1. 通过 `.nojbackup-create.lock`（记录 `{ pid, startedAt }`）阻止并发备份写满磁盘；
 * 2. 仅清理明确受控命名的临时产物（`.nojbackup-staging-*`、`.nojbackup-<pid>-*.tmp`、
 *    `snapshot-*.nojbackup.sha256.<pid>.<uuid>.tmp`），绝不触碰已提交快照、校验和、指标与状态文件；
 * 3. 若锁或临时文件名中的 PID 仍存活，则跳过对应临时产物或拒绝执行，防止误删并发任务。
 */

import { join } from "@std/path";
import { type CommandRunner, realRunner } from "../../runtime/command.ts";

/** 备份排他锁文件名（位于备份目录根下）。 */
export const BACKUP_LOCK_FILE = ".nojbackup-create.lock";

/** 损坏/空锁文件被视为"正在写入中"的宽限期（毫秒）。 */
const CORRUPT_LOCK_GRACE_MS = 60_000;

const STAGING_WITH_PID_RE = /^\.nojbackup-staging-(\d+)-/;
const STAGING_LEGACY_RE = /^\.nojbackup-staging-(?!\d+-)/;
const TEMP_CONTAINER_RE = /^\.nojbackup-(\d+)-[0-9a-f-]+\.tmp$/i;
const TEMP_SIDECAR_RE =
  /^snapshot-.+\.nojbackup\.sha256\.(\d+)\.[0-9a-f-]+\.tmp$/i;

/** 残留清理与锁检测的选项。 */
export interface StaleCleanupOptions {
  runner?: CommandRunner;
  isProcessAlive?: (pid: number) => Promise<boolean>;
  now?: Date;
}

/** 残留清理结果。 */
export interface StaleCleanupResult {
  removed: string[];
  skippedActive: string[];
  reclaimedBytes: number;
  removedStaleLock: boolean;
}

/** 获取进程排他锁的选项。 */
export interface AcquireBackupLockOptions extends StaleCleanupOptions {
  pid?: number;
}

/** 备份排他锁句柄。 */
export interface BackupLockHandle {
  path: string;
  release(): Promise<void>;
}

/** 判定 PID 是否仍存活；不确定时保守返回 `true`，绝不误删并发任务。 */
export async function defaultIsProcessAlive(
  pid: number,
  runner?: CommandRunner,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === Deno.pid) return true;

  if (Deno.build.os === "linux") {
    try {
      await Deno.stat("/proc");
      try {
        await Deno.stat(`/proc/${pid}`);
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
      }
    } catch {
      // 无 `/proc` 时回退 `kill -0`
    }
  }

  try {
    const res = await (runner ?? realRunner()).run("kill", ["-0", String(pid)]);
    if (res.code === 0) return true;
    const stderr = res.stderr.toLowerCase();
    if (
      stderr.includes("not permitted") ||
      stderr.includes("eperm") ||
      stderr.includes("operation not permitted")
    ) {
      return true;
    }
    if (
      stderr.includes("no such process") ||
      stderr.includes("esrch")
    ) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** 递归统计文件或目录的总字节数。 */
async function entrySizeBytes(targetPath: string): Promise<number> {
  try {
    const st = await Deno.lstat(targetPath);
    if (!st.isDirectory) return st.size;
    let total = 0;
    for await (const entry of Deno.readDir(targetPath)) {
      total += await entrySizeBytes(join(targetPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function parseLockPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed.pid;
    }
  } catch {
    // 非 JSON / 半截写入
  }
  return null;
}

/**
 * 校验锁文件并在持有者死亡时删除死锁。
 *
 * 若锁持有者仍存活，或损坏锁文件处于宽限期内（可能正在创建），直接抛错中止。
 * 返回本次是否清理了陈旧锁文件。
 */
async function inspectAndClearLock(
  lockPath: string,
  alive: (pid: number) => Promise<boolean>,
  now: Date,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(lockPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }

  const pid = parseLockPid(raw);
  if (pid !== null) {
    if (await alive(pid)) {
      throw new Error(
        `检测到正在进行的备份任务（PID ${pid}，锁文件 ${lockPath}），为避免并发写满磁盘已中止`,
      );
    }
    await Deno.remove(lockPath).catch(() => {});
    return true;
  }

  // 内容为空或损坏时检查 mtime，避开另一进程刚 open 尚未 write 完成的瞬间
  const st = await Deno.stat(lockPath).catch(() => null);
  const ageMs = st?.mtime ? now.getTime() - st.mtime.getTime() : Infinity;
  if (ageMs >= 0 && ageMs < CORRUPT_LOCK_GRACE_MS) {
    throw new Error(
      `检测到刚创建的备份锁文件 ${lockPath}，为避免并发冲突已中止`,
    );
  }
  await Deno.remove(lockPath).catch(() => {});
  return true;
}

function matchControlledArtifact(
  name: string,
): { matched: false } | { matched: true; pid: number | null } {
  const stagingPid = STAGING_WITH_PID_RE.exec(name);
  if (stagingPid !== null) {
    return { matched: true, pid: Number(stagingPid[1]) };
  }
  if (STAGING_LEGACY_RE.test(name)) {
    return { matched: true, pid: null };
  }
  const tempContainer = TEMP_CONTAINER_RE.exec(name);
  if (tempContainer !== null) {
    return { matched: true, pid: Number(tempContainer[1]) };
  }
  const tempSidecar = TEMP_SIDECAR_RE.exec(name);
  if (tempSidecar !== null) {
    return { matched: true, pid: Number(tempSidecar[1]) };
  }
  return { matched: false };
}

/**
 * 识别并清理上次异常中断遗留的 staging 与临时备份文件。
 *
 * 目录不存在时不创建目录、零写入直接返回。
 */
export async function checkAndCleanStaleBackupArtifacts(
  backupDir: string,
  opts: StaleCleanupOptions = {},
): Promise<StaleCleanupResult> {
  const empty: StaleCleanupResult = {
    removed: [],
    skippedActive: [],
    reclaimedBytes: 0,
    removedStaleLock: false,
  };
  const dirStat = await Deno.stat(backupDir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory) return empty;

  const now = opts.now ?? new Date();
  const alive = opts.isProcessAlive ??
    ((pid: number) => defaultIsProcessAlive(pid, opts.runner));
  const removedStaleLock = await inspectAndClearLock(
    join(backupDir, BACKUP_LOCK_FILE),
    alive,
    now,
  );

  const removed: string[] = [];
  const skippedActive: string[] = [];
  let reclaimedBytes = 0;

  for await (const entry of Deno.readDir(backupDir)) {
    if (entry.name === BACKUP_LOCK_FILE) continue;
    const match = matchControlledArtifact(entry.name);
    if (!match.matched) continue;

    const fullPath = join(backupDir, entry.name);
    if (match.pid !== null && (await alive(match.pid))) {
      skippedActive.push(fullPath);
      continue;
    }

    const bytes = await entrySizeBytes(fullPath);
    try {
      await Deno.remove(fullPath, { recursive: true });
      removed.push(fullPath);
      reclaimedBytes += bytes;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  return { removed, skippedActive, reclaimedBytes, removedStaleLock };
}

async function writeLockExclusive(
  lockPath: string,
  pid: number,
  now: Date,
): Promise<void> {
  const payload = new TextEncoder().encode(
    JSON.stringify({ pid, startedAt: now.toISOString() }) + "\n",
  );
  const file = await Deno.open(lockPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    let written = 0;
    while (written < payload.length) {
      written += await file.write(payload.subarray(written));
    }
  } finally {
    file.close();
  }
}

/** 获取备份目录排他锁；仅在空间预检通过后调用。 */
export async function acquireBackupLock(
  backupDir: string,
  opts: AcquireBackupLockOptions = {},
): Promise<BackupLockHandle> {
  await Deno.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const lockPath = join(backupDir, BACKUP_LOCK_FILE);
  const pid = opts.pid ?? Deno.pid;
  const now = opts.now ?? new Date();
  const alive = opts.isProcessAlive ??
    ((targetPid: number) => defaultIsProcessAlive(targetPid, opts.runner));

  try {
    await writeLockExclusive(lockPath, pid, now);
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    await inspectAndClearLock(lockPath, alive, now);
    try {
      await writeLockExclusive(lockPath, pid, now);
    } catch (retryErr) {
      if (retryErr instanceof Deno.errors.AlreadyExists) {
        throw new Error(
          `检测到并发备份正在创建锁文件 ${lockPath}，已中止本次备份`,
        );
      }
      throw retryErr;
    }
  }

  return {
    path: lockPath,
    async release() {
      try {
        const raw = await Deno.readTextFile(lockPath);
        if (parseLockPid(raw) === pid) {
          await Deno.remove(lockPath).catch(() => {});
        }
      } catch {
        // 已被清理或不存在则忽略
      }
    },
  };
}
