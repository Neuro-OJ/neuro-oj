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

  const pgDump = await r.run(
    "docker",
    prodComposeArgs(base, [
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
  );
  Deno.writeFileSync(
    `${snapshot}/postgres.dump`,
    new TextEncoder().encode(pgDump.stdout),
  );

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
  Deno.writeTextFileSync(`${snapshot}/postgres-globals.sql`, globals.stdout);

  const redisRdb = await r.run(
    "docker",
    prodComposeArgs(base, [
      "exec",
      "-T",
      "redis",
      "sh",
      "-c",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --rdb -',
    ]),
  );
  Deno.writeFileSync(
    `${snapshot}/redis.rdb`,
    new TextEncoder().encode(redisRdb.stdout),
  );

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
    { stdin: Deno.readTextFileSync(`${opts.snapshot}/postgres.dump`) },
  );
  return pg.code;
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
