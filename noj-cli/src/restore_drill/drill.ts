/** restore-drill 编排实现。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { RestoreDrillOptions } from "./options.ts";
import {
  checkSecretFile,
  checkSnapshotFiles,
  hoursSinceSnapshot,
  snapshotCreatedAt,
  validateSnapshotPath,
  verifySnapshot,
} from "./snapshot.ts";
import {
  composeArgs,
  type DrillComposePaths,
  runDrillCompose,
  writeDrillOverride,
} from "./compose.ts";

export interface DrillContext {
  startAt: string;
  tempDir: string;
  report: string;
  composeEnvFile: string;
  overrideFile: string;
  keep: boolean;
  stage: string;
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of Deno.readTextFileSync(file).split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) values[key] = value;
    }
  } catch {
    // 忽略
  }
  return values;
}

function envGet(
  env: Record<string, string>,
  key: string,
  fallback: string,
): string {
  const v = env[key];
  return v !== undefined ? v : fallback;
}

function prepareDirs(opts: RestoreDrillOptions, ctx: DrillContext): void {
  const parent = opts.snapshot.includes("/")
    ? opts.snapshot.slice(0, opts.snapshot.lastIndexOf("/"))
    : ".";
  const defaultDir = `${parent}/drill-${ctx.startAt.replace(/[^0-9]/g, "")}`;
  const drillDir = opts.drillDir ?? defaultDir;
  Deno.mkdirSync(drillDir, { recursive: true, mode: 0o700 });
  ctx.tempDir = `${drillDir}/.work`;
  Deno.mkdirSync(ctx.tempDir, { recursive: true, mode: 0o700 });
  ctx.report = opts.report ?? `${opts.snapshot}/restore-drill-report.txt`;
  Deno.writeTextFileSync(ctx.report, "");
  Deno.chmodSync(ctx.report, 0o600);
}

async function prepareEnv(
  opts: RestoreDrillOptions,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  const gpgArgs = [
    "--batch",
    "--yes",
    "--pinentry-mode",
    "loopback",
    "--passphrase-file",
    opts.passphraseFile,
    "--decrypt",
    "--output",
    ctx.composeEnvFile,
    `${opts.snapshot}/env.prod.gpg`,
  ];
  const r = await runner.run("gpg", gpgArgs);
  if (r.code !== 0) throw new Error("解密生产环境文件失败");
  try {
    Deno.statSync(ctx.composeEnvFile);
  } catch {
    Deno.writeTextFileSync(ctx.composeEnvFile, "");
  }
  Deno.chmodSync(ctx.composeEnvFile, 0o600);
  Deno.writeTextFileSync(
    ctx.composeEnvFile,
    "\n# ---- restore-drill 隔离覆盖 ----\n" +
      `JUDGE_EVALUATOR_NETWORK=${opts.projectName}_noj-net\n`,
    { append: true },
  );
}

async function composeUp(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  services: string[],
  runner: CommandRunner,
): Promise<void> {
  const code = await runDrillCompose(opts, paths, [
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    String(opts.waitTimeout),
    ...services,
  ], runner);
  if (code !== 0) {
    throw new Error(`Compose 服务启动失败: ${services.join(",")}`);
  }
}

async function restoreData(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  const env = readEnvFile(ctx.composeEnvFile);
  const pgUser = envGet(env, "POSTGRES_USER", "noj");
  const pgDb = envGet(env, "POSTGRES_DB", "noj");

  await composeUp(opts, paths, ["postgres", "redis", "minio"], runner);
  await runDrillCompose(opts, paths, ["run", "--rm", "minio-init"], runner);

  // PostgreSQL globals -> idempotent
  const globals = Deno.readTextFileSync(`${opts.snapshot}/postgres-globals.sql`)
    .replace(
      /^CREATE ROLE /gm,
      "DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'noj') THEN CREATE ROLE noj; END IF; END $role$;\n",
    );
  const globalsFile = `${ctx.tempDir}/postgres-globals.sql`;
  Deno.writeTextFileSync(globalsFile, globals);
  const psql = await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      pgUser,
      "-d",
      pgDb,
    ]),
    { stdin: globals },
  );
  if (psql.code !== 0) throw new Error("PostgreSQL 全局对象恢复失败");

  const dump = Deno.readFileSync(`${opts.snapshot}/postgres.dump`);
  const pgRestore = await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "-U",
      pgUser,
      "-d",
      pgDb,
    ]),
    { stdin: new TextDecoder().decode(dump) },
  );
  if (pgRestore.code !== 0) throw new Error("PostgreSQL 数据恢复失败");

  await runDrillCompose(opts, paths, ["stop", "redis"], runner);
  const redisRdb = Deno.readTextFileSync(`${opts.snapshot}/redis.rdb`);
  const redisWrite = await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "redis",
      "-c",
      "set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb",
    ]),
    { stdin: redisRdb },
  );
  if (redisWrite.code !== 0) throw new Error("Redis RDB 恢复失败");
  await composeUp(opts, paths, ["redis"], runner);

  const minioArgs = composeArgs(opts, paths, [
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
  ]);
  const minio = await runner.run("docker", minioArgs);
  if (minio.code !== 0) throw new Error("MinIO/S3 对象恢复失败");
  ctx.stage = "restore-data";
}

async function verifyData(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  const env = readEnvFile(ctx.composeEnvFile);
  const pgUser = envGet(env, "POSTGRES_USER", "noj");
  const pgDb = envGet(env, "POSTGRES_DB", "noj");
  const expected = Deno.readTextFileSync(
    `${opts.snapshot}/migration-status.txt`,
  ).trim();
  const actual = (await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      pgUser,
      "-d",
      pgDb,
      "-Atqc",
      "SELECT hash || ':' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
    ]),
  )).stdout.trim();
  if (expected === "" || expected === "not-initialized") {
    throw new Error("数据核对失败：快照缺少迁移状态记录");
  }
  if (expected !== actual) {
    throw new Error("数据核对失败：迁移版本与快照不一致");
  }
  const userCount = (await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      pgUser,
      "-d",
      pgDb,
      "-Atqc",
      "SELECT count(*) FROM users",
    ]),
  )).stdout.trim();
  if (!/^\d+$/.test(userCount)) throw new Error("数据核对失败：无法读取用户数");
  const _redisKeys = (await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "redis",
      "sh",
      "-c",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning DBSIZE',
    ]),
  )).stdout.trim();
  const snapshotObjects = countFiles(`${opts.snapshot}/minio`);
  const restoredObjects = Number(
    (await runner.run(
      "docker",
      composeArgs(opts, paths, [
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "minio-init",
        "-c",
        'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc ls --recursive --json "local/$S3_BUCKET" | wc -l',
      ]),
    )).stdout.trim(),
  );
  if (Number.isNaN(restoredObjects) || restoredObjects < snapshotObjects) {
    throw new Error("数据核对失败：MinIO 对象数少于快照");
  }
  ctx.stage = "verify-data";
}

function countFiles(dir: string): number {
  let count = 0;
  try {
    for (const _ of Deno.readDirSync(dir)) count++;
  } catch {
    // ignore
  }
  return count;
}

async function seedDrillAdmin(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  const env = readEnvFile(ctx.composeEnvFile);
  const pgUser = envGet(env, "POSTGRES_USER", "noj");
  const pgDb = envGet(env, "POSTGRES_DB", "noj");
  const now = new Date().toISOString();
  const sql =
    `INSERT INTO users (id, username, email, password_hash, created_at, updated_at)
VALUES ('drill-admin-user', 'drill_admin', 'drill-admin@restore-drill.invalid',
        '$2b$12$edDmxsubnHJL8B/Wsdryxu4ibNin0/SEhqAXkB.Yn50SCoN29lQCW', '${now}', '${now}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO user_roles (user_id, role_id)
SELECT 'drill-admin-user', id FROM roles WHERE name = 'admin'
ON CONFLICT DO NOTHING;
`;
  const r = await runner.run(
    "docker",
    composeArgs(opts, paths, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      pgUser,
      "-d",
      pgDb,
    ]),
    { stdin: sql },
  );
  if (r.code !== 0) throw new Error("写入演练管理员失败");
  ctx.stage = "seed-admin";
}

async function startBusiness(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  await runDrillCompose(opts, paths, ["run", "--rm", "migrate"], runner);
  await composeUp(opts, paths, ["core"], runner);
  if (!opts.skipJudge) {
    await composeUp(opts, paths, ["judge"], runner);
  }
  ctx.stage = "start-business";
}

async function runBusinessVerify(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  ctx: DrillContext,
  runner: CommandRunner,
): Promise<void> {
  const verifyScript = `${Deno.cwd()}/scripts/deploy/restore-drill-verify.ts`;
  const env = [
    "-e",
    "DRILL_BASE_URL=http://core:8000/api/v1",
    "-e",
    "DRILL_ADMIN_USER=drill_admin",
    "-e",
    "DRILL_ADMIN_PASSWORD=Drill-Recover-2026",
    "-e",
    "DRILL_EVALUATOR_IMAGE=noj-evaluator-python",
    "-e",
    "DRILL_SOLUTION_IMAGE=noj-solution-python",
  ];
  if (opts.skipJudge) env.push("-e", "DRILL_SKIP_EVALUATION=1");
  const args = [
    "run",
    "--rm",
    "--no-deps",
    ...env,
    "-v",
    `${verifyScript}:/opt/verify.ts:ro`,
    "verifier",
    "deno",
    "run",
    "-A",
    "/opt/verify.ts",
  ];
  const r = await runDrillCompose(opts, paths, args, runner);
  if (r !== 0) throw new Error("业务验收未通过");
  ctx.stage = "business-verify";
}

function writeReport(
  opts: RestoreDrillOptions,
  ctx: DrillContext,
  restoreSeconds: number,
  totalSeconds: number,
): void {
  const rpoHours = hoursSinceSnapshot(snapshotCreatedAt(opts.snapshot));
  const rtoMinutes = Math.floor(totalSeconds / 60);
  const rpoMet = rpoHours <= opts.rpoMaxHours;
  const rtoMet = opts.rtoMaxMinutes >= rtoMinutes;
  const result = rpoMet && rtoMet ? "passed" : "passed_with_warnings";
  const lines = [
    `result=${result}`,
    "drill_type=isolated-restore-with-business-verification",
    `snapshot=${opts.snapshot}`,
    `snapshot_created_at=${snapshotCreatedAt(opts.snapshot)}`,
    `drill_started_at=${ctx.startAt}`,
    `drill_finished_at=${new Date().toISOString()}`,
    `restore_duration_seconds=${restoreSeconds}`,
    `total_duration_seconds=${totalSeconds}`,
    `rpo_hours=${rpoHours.toFixed(2)}`,
    `rpo_target_hours=${opts.rpoMaxHours}`,
    `rpo_met=${rpoMet}`,
    `rto_minutes=${rtoMinutes}`,
    `rto_target_minutes=${opts.rtoMaxMinutes}`,
    `rto_met=${rtoMet}`,
    `compose_project=${opts.projectName}`,
    `network_subnet=${opts.subnet}`,
    `cleanup=${opts.keep ? "kept-for-review" : "done"}`,
    "credential_note=备份快照与 GPG 口令文件应异地独立保存；口令丢失即无法恢复。",
  ];
  Deno.writeTextFileSync(ctx.report, lines.join("\n") + "\n");
  Deno.chmodSync(ctx.report, 0o600);
}

export async function runRestoreDrill(
  opts: RestoreDrillOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    opts.snapshot = validateSnapshotPath(opts.snapshot);
    const pre = [
      ...checkSnapshotFiles(opts.snapshot),
      ...(opts.passphraseFile
        ? checkSecretFile(opts.passphraseFile)
        : ["必须提供 --passphrase-file"]),
    ];
    if (pre.length > 0) throw new Error(pre.join("; "));
    const verifyProblems = await verifySnapshot({
      snapshot: opts.snapshot,
      envFile: opts.envFile ?? "",
      composeFile: opts.composeFile ?? "",
      passphraseFile: opts.passphraseFile,
      runner: r,
    });
    if (verifyProblems.length > 0) throw new Error(verifyProblems.join("; "));
    if (!opts.envFile) throw new Error("restore-drill: 缺少 --env-file");
    if (!opts.composeFile) {
      throw new Error("restore-drill: 缺少 --compose-file");
    }

    const startAt = new Date().toISOString();
    const ctx: DrillContext = {
      startAt,
      tempDir: "",
      report: "",
      composeEnvFile: "",
      overrideFile: "",
      keep: opts.keep,
      stage: "init",
    };
    prepareDirs(opts, ctx);
    ctx.composeEnvFile = `${ctx.tempDir}/env.drill`;
    ctx.overrideFile = `${ctx.tempDir}/compose.drill-override.yml`;
    const paths: DrillComposePaths = {
      envFile: ctx.composeEnvFile,
      overrideFile: ctx.overrideFile,
      composeFile: opts.composeFile,
    };
    await prepareEnv(opts, ctx, r);
    writeDrillOverride(ctx.overrideFile, opts.subnet);
    const totalStart = Date.now();
    await restoreData(opts, paths, ctx, r);
    await verifyData(opts, paths, ctx, r);
    const restoreEnd = Date.now();
    await seedDrillAdmin(opts, paths, ctx, r);
    await startBusiness(opts, paths, ctx, r);
    await runBusinessVerify(opts, paths, ctx, r);
    const totalSeconds = Math.round((Date.now() - totalStart) / 1000);
    const restoreSeconds = Math.round((restoreEnd - totalStart) / 1000);
    writeReport(opts, ctx, restoreSeconds, totalSeconds);

    if (!opts.keep) {
      await r.run(
        "docker",
        composeArgs(opts, paths, ["down", "-v", "--remove-orphans"]),
      );
    }
    return 0;
  } catch (e) {
    console.error(`restore-drill: ${(e as Error).message}`);
    return 1;
  }
}
