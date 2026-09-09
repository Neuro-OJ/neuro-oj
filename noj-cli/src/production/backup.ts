/** 生产备份 create/verify/restore/drill。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { prodComposeArgs, runProdCompose } from "./compose.ts";
import { verifySnapshot } from "../restore_drill/snapshot.ts";

export interface ProdBackupOptions {
  envFile: string;
  composeFile: string;
  backupDir: string;
  passphraseFile: string;
  snapshot?: string;
  confirm?: boolean;
  report?: string;
  retentionDays?: number;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function sha256File(file: string): Promise<string> {
  const data = await Deno.readFile(file);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function writeSha256Sums(snapshot: string): Promise<void> {
  const lines: string[] = [];
  for await (const entry of Deno.readDir(snapshot)) {
    if (!entry.isFile || entry.name === "sha256sums.txt") continue;
    const file = `${snapshot}/${entry.name}`;
    lines.push(`${await sha256File(file)}  ${entry.name}`);
  }
  lines.sort();
  Deno.writeTextFileSync(`${snapshot}/sha256sums.txt`, lines.join("\n") + "\n");
}

function pruneOldSnapshots(backupDir: string, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of Deno.readDirSync(backupDir)) {
    if (!entry.isDirectory || !entry.name.startsWith("snapshot-")) continue;
    const full = `${backupDir}/${entry.name}`;
    const stat = Deno.statSync(full);
    if (stat.mtime !== null && stat.mtime.getTime() < cutoff) {
      Deno.removeSync(full, { recursive: true });
    }
  }
}

export async function prodBackupCreate(
  opts: ProdBackupOptions,
  runner?: CommandRunner,
): Promise<string> {
  const r = runner ?? realRunner();
  const snapshot = `${opts.backupDir}/snapshot-${timestamp()}`;
  Deno.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  const base = { envFile: opts.envFile, composeFile: opts.composeFile };

  // pg_dump -Fc 输出为二进制，直接经 spawn 流式写入文件，避免 UTF-8 文本解码损坏。
  const pgDumpHandle = r.spawn({
    cmd: "docker",
    args: prodComposeArgs(base, [
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "noj",
      "-d",
      "noj",
      "-Fc",
    ]),
    cwd: Deno.cwd(),
    env: {},
    stdoutFile: `${snapshot}/postgres.dump`,
  });
  const pgDumpCode = await pgDumpHandle.wait();
  if (pgDumpCode !== 0) {
    throw new Error("pg_dump 失败");
  }

  const globals = await r.run(
    "docker",
    prodComposeArgs(base, [
      "exec",
      "-T",
      "postgres",
      "pg_dumpall",
      "-U",
      "noj",
      "--globals-only",
      "--no-role-passwords",
    ]),
  );
  if (globals.code !== 0) {
    throw new Error(`pg_dumpall 失败: ${globals.stderr || globals.stdout}`);
  }
  Deno.writeTextFileSync(`${snapshot}/postgres-globals.sql`, globals.stdout);

  // redis RDB 同样为二进制，直接流式写入文件。
  const redisRdbHandle = r.spawn({
    cmd: "docker",
    args: prodComposeArgs(base, [
      "exec",
      "-T",
      "redis",
      "sh",
      "-c",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --rdb -',
    ]),
    cwd: Deno.cwd(),
    env: {},
    stdoutFile: `${snapshot}/redis.rdb`,
  });
  const redisRdbCode = await redisRdbHandle.wait();
  if (redisRdbCode !== 0) {
    throw new Error("redis RDB 导出失败");
  }

  // 恢复/校验读取二进制 dump 时从文件直接喂 stdin，避免文本转换。
  const restoreList = await r.run(
    "docker",
    prodComposeArgs(base, [
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--list",
    ]),
    { stdinFile: `${snapshot}/postgres.dump` },
  );
  if (restoreList.code !== 0) {
    throw new Error(
      `pg_restore --list 失败: ${restoreList.stderr || restoreList.stdout}`,
    );
  }
  Deno.writeTextFileSync(
    `${snapshot}/postgres.restore-list`,
    restoreList.stdout,
  );

  Deno.mkdirSync(`${snapshot}/minio`, { recursive: true, mode: 0o700 });
  const minio = await r.run(
    "docker",
    prodComposeArgs(base, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${snapshot}/minio:/backup:rw`,
      "minio-init",
      "-c",
      'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --preserve "local/$S3_BUCKET" /backup',
    ]),
  );
  if (minio.code !== 0) {
    throw new Error(`MinIO 备份失败: ${minio.stderr || minio.stdout}`);
  }

  Deno.writeTextFileSync(
    `${snapshot}/manifest.json`,
    JSON.stringify({ created_at: new Date().toISOString() }, null, 2),
  );
  Deno.writeTextFileSync(`${snapshot}/SUCCESS`, "success\n");
  await writeSha256Sums(snapshot);
  Deno.chmodSync(snapshot, 0o700);
  pruneOldSnapshots(opts.backupDir, opts.retentionDays ?? 30);
  return snapshot;
}

export async function prodBackupVerify(
  opts: ProdBackupOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  if (!opts.snapshot) {
    console.error("backup verify: 需要 <snapshot>");
    return 1;
  }
  const problems = await verifySnapshot({
    snapshot: opts.snapshot,
    envFile: opts.envFile,
    composeFile: opts.composeFile,
    passphraseFile: opts.passphraseFile,
    runner: r,
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log("备份校验通过");
  return 0;
}

export async function prodBackupRestore(
  opts: ProdBackupOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  if (!opts.confirm) {
    console.error("restore 需要 --confirm");
    return 1;
  }
  const base = { envFile: opts.envFile, composeFile: opts.composeFile };
  const up = await runProdCompose(base, [
    "up",
    "-d",
    "--wait",
    "postgres",
    "redis",
    "minio",
  ], r);
  if (up !== 0) return up;
  const pg = await r.run(
    "docker",
    prodComposeArgs(base, [
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "-U",
      "noj",
      "-d",
      "noj",
    ]),
    { stdinFile: `${opts.snapshot}/postgres.dump` },
  );
  if (pg.code !== 0) return pg.code;

  await runProdCompose(base, ["stop", "redis"], r);
  const redisWrite = await r.run(
    "docker",
    prodComposeArgs(base, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "redis",
      "-c",
      "set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb",
    ]),
    { stdinFile: `${opts.snapshot}/redis.rdb` },
  );
  if (redisWrite.code !== 0) return redisWrite.code;
  const upRedis = await runProdCompose(
    base,
    ["up", "-d", "--wait", "redis"],
    r,
  );
  if (upRedis !== 0) return upRedis;

  const minio = await r.run(
    "docker",
    prodComposeArgs(base, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${opts.snapshot}/minio:/restore:ro`,
      "minio-init",
      "-c",
      'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --overwrite --remove /restore "local/$S3_BUCKET"',
    ]),
  );
  return minio.code;
}

export async function prodBackupDrill(
  opts: ProdBackupOptions,
  runner?: CommandRunner,
): Promise<number> {
  const code = await prodBackupVerify(opts, runner);
  if (code !== 0) return code;
  const report = opts.report ?? `${opts.snapshot}/restore-drill.txt`;
  Deno.writeTextFileSync(
    report,
    "result=verified\ndrill_type=file-verification-only\n",
  );
  Deno.chmodSync(report, 0o600);
  console.log(`演练完成（drill）：${report}`);
  return 0;
}
