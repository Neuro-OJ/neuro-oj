/**
 * 启动时锁校验与崩溃残留清理单元测试。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  acquireBackupLock,
  BACKUP_LOCK_FILE,
  checkAndCleanStaleBackupArtifacts,
} from "./stale-cleanup.ts";

Deno.test("stale-cleanup: 目录不存在时零写入直接返回空结果", async () => {
  const root = await Deno.makeTempDir();
  try {
    const missing = join(root, "does-not-exist", "backups");
    const result = await checkAndCleanStaleBackupArtifacts(missing);
    assertEquals(result, {
      removed: [],
      skippedActive: [],
      reclaimedBytes: 0,
      removedStaleLock: false,
    });
    const exists = await Deno.stat(missing).then(() => true).catch(() => false);
    assertEquals(exists, false, "不得在清理检查时顺便创建目录");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stale-cleanup: 清除死锁及全部崩溃临时残留，保留正式快照与状态文件", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const now = new Date("2026-11-21T00:00:00Z");
    await Deno.writeTextFile(
      join(dir, BACKUP_LOCK_FILE),
      JSON.stringify({ pid: 99991, startedAt: "2026-11-20T00:00:00Z" }),
    );
    const stagingWithPid = join(dir, ".nojbackup-staging-99991-abc");
    await Deno.mkdir(stagingWithPid, { recursive: true });
    await Deno.writeTextFile(join(stagingWithPid, "postgres.dump"), "123456");

    const stagingLegacy = join(dir, ".nojbackup-staging-xyz");
    await Deno.mkdir(stagingLegacy, { recursive: true });
    await Deno.writeTextFile(join(stagingLegacy, "redis.rdb"), "abcd");

    const stagingTar = join(dir, ".nojbackup-staging-99991-abc.tar.zst");
    await Deno.writeTextFile(stagingTar, "tar-bytes");

    const tempContainer = join(
      dir,
      ".nojbackup-99991-123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    await Deno.writeTextFile(tempContainer, "partial-gpg");

    const tempSidecar = join(
      dir,
      "snapshot-20261120-000000.nojbackup.sha256.99991.123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    await Deno.writeTextFile(tempSidecar, "sha");

    // 必须保留的正常文件
    const snap = join(dir, "snapshot-20261120-000000.nojbackup");
    const sidecar = join(dir, "snapshot-20261120-000000.nojbackup.sha256");
    const stateFile = join(dir, "upgrade-state.json");
    const metricsDir = join(dir, "metrics");
    await Deno.writeTextFile(snap, "real-backup");
    await Deno.writeTextFile(sidecar, "real-sha");
    await Deno.writeTextFile(stateFile, "{}");
    await Deno.mkdir(metricsDir, { recursive: true });
    await Deno.writeTextFile(join(metricsDir, "noj_backup.prom"), "metric 1\n");

    const result = await checkAndCleanStaleBackupArtifacts(dir, {
      isProcessAlive: () => Promise.resolve(false),
      now,
    });
    assertEquals(result.removedStaleLock, true);
    assertEquals(result.skippedActive, []);
    assertEquals(result.removed.length, 5);
    // "123456"(6) + "abcd"(4) + "tar-bytes"(9) + "partial-gpg"(11) + "sha"(3) = 33
    assertEquals(result.reclaimedBytes, 33);

    for (
      const deleted of [
        join(dir, BACKUP_LOCK_FILE),
        stagingWithPid,
        stagingLegacy,
        stagingTar,
        tempContainer,
        tempSidecar,
      ]
    ) {
      const exists = await Deno.stat(deleted).then(() => true).catch(() =>
        false
      );
      assertEquals(exists, false, `${deleted} 应被清理`);
    }
    for (
      const kept of [
        snap,
        sidecar,
        stateFile,
        join(metricsDir, "noj_backup.prom"),
      ]
    ) {
      const exists = await Deno.stat(kept).then(() => true).catch(() => false);
      assertEquals(exists, true, `${kept} 绝不能被误删`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stale-cleanup: 活锁拒绝执行且零删除；无锁但含活跃 PID 临时产物则跳过", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lockPath = join(dir, BACKUP_LOCK_FILE);
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({ pid: 4242, startedAt: "2026-11-21T00:00:00Z" }),
    );
    const activeStaging = join(dir, ".nojbackup-staging-4242-live");
    await Deno.mkdir(activeStaging, { recursive: true });
    await Deno.writeTextFile(join(activeStaging, "x"), "keep");
    const deadTmp = join(
      dir,
      ".nojbackup-8888-123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    await Deno.writeTextFile(deadTmp, "dead");

    await assertRejects(
      () =>
        checkAndCleanStaleBackupArtifacts(dir, {
          isProcessAlive: (pid) => Promise.resolve(pid === 4242),
        }),
      Error,
      "PID 4242",
    );
    assert(
      await Deno.stat(activeStaging).then(() => true).catch(() => false),
      "命中活锁时绝不能删除任何目录或文件",
    );
    assert(
      await Deno.stat(deadTmp).then(() => true).catch(() => false),
      "命中活锁直接中止，不继续删其他条目",
    );

    // 删除锁后，无锁但文件名 PID 4242 仍存活：仅跳过 4242，清理死 PID 8888
    await Deno.remove(lockPath);
    const res = await checkAndCleanStaleBackupArtifacts(dir, {
      isProcessAlive: (pid) => Promise.resolve(pid === 4242),
    });
    assertEquals(res.removedStaleLock, false);
    assertEquals(res.skippedActive, [activeStaging]);
    assertEquals(res.removed, [deadTmp]);
    assertEquals(res.reclaimedBytes, 4);
    assert(await Deno.stat(activeStaging).then(() => true).catch(() => false));
    assertEquals(
      await Deno.stat(deadTmp).then(() => true).catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("acquireBackupLock: 排他持锁、抢占死锁与 release 释放", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const alivePids = new Set<number>([1001]);
    const lock1 = await acquireBackupLock(dir, {
      pid: 1001,
      isProcessAlive: (pid) => Promise.resolve(alivePids.has(pid)),
    });
    assertEquals(
      await Deno.stat(lock1.path).then(() => true).catch(() => false),
      true,
    );
    const mode = ((await Deno.stat(lock1.path)).mode ?? 0) & 0o777;
    assertEquals(mode, 0o600);

    // 活锁互斥
    const msg = await assertRejects(
      () =>
        acquireBackupLock(dir, {
          pid: 2002,
          isProcessAlive: (pid) => Promise.resolve(alivePids.has(pid)),
        }),
      Error,
    );
    assertStringIncludes(msg.message, "1001");

    // 模拟 1001 死亡后 2002 自动清理死锁并成功持锁
    alivePids.delete(1001);
    alivePids.add(2002);
    const lock2 = await acquireBackupLock(dir, {
      pid: 2002,
      isProcessAlive: (pid) => Promise.resolve(alivePids.has(pid)),
    });
    // 原 1001 的 release() 不得误删 2002 持有的新锁
    await lock1.release();
    assert(
      await Deno.stat(lock2.path).then(() => true).catch(() => false),
      "旧句柄释放时若 PID 已变更不得误删新锁",
    );
    await lock2.release();
    assertEquals(
      await Deno.stat(lock2.path).then(() => true).catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
