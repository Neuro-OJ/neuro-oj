/**
 * HTTP 启动边界的真实 PostgreSQL 回归。
 *
 * 本用例用启动器当前 run 的 admin 连接创建本 run 专属数据库，再用 Drizzle
 * 官方 migrator 准备一个匹配库。HTTP 子进程只读取迁移 ledger；空库、迁移资产
 * 漂移和生产配置部分初始化失败都必须在监听 HTTP 前退出，且不能留下连接。
 * 匹配库则必须真正回应 /health/live，并能在 SIGTERM 后完成清理。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  type MigrationConfig,
  type MigrationMeta,
  readMigrationFiles,
} from "drizzle-orm/migrator";
import postgres from "postgres";
import {
  assertDatabaseIdentifier,
  isOwnedDatabaseName,
} from "../../scripts/test-launcher-resources.ts";
import { assertOwnedTestDatabase } from "../helpers/db.ts";

const CORE_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
const MIGRATIONS_DIR = resolve(CORE_ROOT, "drizzle");
const MIGRATION_CONFIG: MigrationConfig = {
  migrationsFolder: MIGRATIONS_DIR,
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

type PgClient = ReturnType<typeof postgres>;
type PgMigrationSession = Parameters<PgDialect["migrate"]>[1];

interface CommandOutput {
  code: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function currentDatabaseUrl(): string {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL 未设置：HTTP 启动测试必须使用真实 PostgreSQL",
    );
  }
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function currentRedisUrl(): string {
  const redisUrl = Deno.env.get("REDIS_URL");
  if (!redisUrl) {
    throw new Error("REDIS_URL 未设置：HTTP 启动测试必须使用专用 Redis");
  }
  return redisUrl;
}

function migrationSession(client: PgClient): PgMigrationSession {
  return drizzlePg(client)._.session as unknown as PgMigrationSession;
}

async function createOwnedDatabase(
  admin: PgClient,
  prefix: string,
  suffix: string,
  created: string[],
): Promise<string> {
  const databaseName = assertDatabaseIdentifier(`${prefix}_${suffix}`);
  if (!isOwnedDatabaseName(databaseName, prefix)) {
    throw new Error(`HTTP 启动测试数据库不属于本 run：${databaseName}`);
  }
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created.push(databaseName);
  return databaseName;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrateDatabase(
  databaseUrl: string,
): Promise<MigrationMeta[]> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const migrations = readMigrationFiles(MIGRATION_CONFIG);
    await new PgDialect().migrate(
      migrations,
      migrationSession(client),
      MIGRATION_CONFIG,
    );
    return migrations;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function readDatabaseState(
  databaseUrl: string,
): Promise<
  {
    database: string;
    users: string | null;
    ledger: string | null;
    count: number;
  }
> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client`
      SELECT current_database() AS database,
             to_regclass('public.users')::text AS users,
             to_regclass('drizzle.__drizzle_migrations')::text AS ledger
    `;
    let count = 0;
    if (rows[0]?.ledger !== null) {
      const ledgerRows = await client`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
      `;
      count = Number(ledgerRows[0]?.count ?? 0);
    }
    return {
      database: String(rows[0]?.database ?? ""),
      users: rows[0]?.users === null ? null : String(rows[0]?.users ?? ""),
      ledger: rows[0]?.ledger === null ? null : String(rows[0]?.ledger ?? ""),
      count,
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function copyDrizzleAssetsWithDrift(): Promise<string> {
  const directory = await Deno.makeTempDir({
    prefix: "noj-http-schema-drift-",
  });
  await Deno.mkdir(`${directory}/meta`, { recursive: true });
  await Deno.copyFile(
    `${MIGRATIONS_DIR}/meta/_journal.json`,
    `${directory}/meta/_journal.json`,
  );
  const journal = JSON.parse(
    await Deno.readTextFile(`${MIGRATIONS_DIR}/meta/_journal.json`),
  ) as { entries: Array<{ tag: string }> };
  const firstTag = journal.entries[0]?.tag;
  if (!firstTag) throw new Error("正式迁移 journal 没有首条记录");
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const source = `${MIGRATIONS_DIR}/${entry.name}`;
    const target = `${directory}/${entry.name}`;
    if (entry.name === `${firstTag}.sql`) {
      const content = await Deno.readTextFile(source);
      await Deno.writeTextFile(target, `${content}\n-- 发布集漂移探针\n`);
    } else {
      await Deno.copyFile(source, target);
    }
  }
  return directory;
}

function decodeOutput(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function waitForExit(
  outputPromise: Promise<CommandOutput>,
  timeoutMs: number,
): Promise<CommandOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`HTTP 启动子进程超过 ${timeoutMs}ms 未退出`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([outputPromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForLive(
  outputPromise: Promise<CommandOutput>,
  port: number,
): Promise<boolean> {
  let exited = false;
  outputPromise.then(
    () => exited = true,
    () => exited = true,
  );
  const url = `http://127.0.0.1:${port}/health/live`;
  const deadline = Date.now() + 15_000;
  while (!exited && Date.now() < deadline) {
    try {
      const response = await fetch(url);
      try {
        if (response.status === 200) return true;
      } finally {
        await response.body?.cancel();
      }
    } catch {
      // 监听尚未建立，继续轮询；最终失败由调用方读取子进程输出诊断。
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  return false;
}

function reservePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr;
  if (address.transport !== "tcp") {
    listener.close();
    throw new Error("无法为 HTTP 启动测试获取 TCP 端口");
  }
  const port = address.port;
  listener.close();
  return port;
}

async function runMainProcess(options: {
  databaseUrl: string;
  migrationsDir: string;
  production?: boolean;
  expectLive?: boolean;
}): Promise<CommandOutput> {
  const storageRoot = await Deno.makeTempDir({
    prefix: "noj-http-startup-storage-",
  });
  const port = await reservePort();
  const env = {
    ...Deno.env.toObject(),
    DATABASE_URL: options.databaseUrl,
    REDIS_URL: currentRedisUrl(),
    NOJ_MIGRATIONS_DIR: options.migrationsDir,
    NOJ_ENV: options.production ? "production" : "test",
    PORT: String(port),
    STORAGE_PROVIDER: "local",
    SUPPORT_PACKAGE_DIR: storageRoot,
    JWT_SECRET: "p2b-http-start-20261020-f7c3a9d1e4b6c8a0",
    TFA_ENCRYPTION_KEY: "p2b-runtime-key-20261020-f7c3a9d1e4b6c8a0",
    BCRYPT_SALT_ROUNDS: "4",
  };
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts"],
    cwd: CORE_ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const outputPromise = child.output() as Promise<CommandOutput>;
  try {
    if (options.expectLive) {
      const live = await waitForLive(outputPromise, port);
      if (!live) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 子进程可能已在轮询期间退出。
        }
        const output = await waitForExit(outputPromise, 10_000);
        throw new Error(
          `HTTP 匹配库未启动（code=${output.code}）：${
            decodeOutput(output.stderr).slice(-2000)
          }`,
        );
      }
      child.kill("SIGTERM");
    }
    return await waitForExit(
      outputPromise,
      options.expectLive ? 35_000 : 15_000,
    );
  } finally {
    try {
      if (options.expectLive) child.kill("SIGKILL");
    } catch {
      // 已退出时无需再次发送信号。
    }
    await Deno.remove(storageRoot, { recursive: true }).catch(() => {});
  }
}

async function waitForNoSessions(
  admin: PgClient,
  databaseName: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await admin`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
    `;
    if (Number(rows[0]?.count ?? 0) === 0) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`启动失败后仍有 PostgreSQL 会话连接数据库 ${databaseName}`);
}

Deno.test({
  name: "HTTP 启动：空库、匹配库、漂移库和部分初始化失败均有明确边界",
  sanitizeResources: false,
  sanitizeOps: false,
  timeout: 120_000,
  fn: async () => {
    const currentDatabase = await assertOwnedTestDatabase();
    const prefix = Deno.env.get("NOJ_TEST_DATABASE_PREFIX")?.trim();
    if (!prefix) throw new Error("缺少当前 run 数据库前缀");
    const adminUrl = currentDatabaseUrl();
    const admin = postgres(adminUrl, { max: 1 });
    const created: string[] = [];
    let driftDir: string | undefined;
    try {
      // 名称固定带当前 run 前缀，并在 DROP 前用同一前缀再次校验，避免测试失败时误触开发库。
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const emptyName = await createOwnedDatabase(
        admin,
        prefix,
        `http_empty_${suffix}`,
        created,
      );
      const matchingName = await createOwnedDatabase(
        admin,
        prefix,
        `http_matching_${suffix}`,
        created,
      );
      const emptyUrl = databaseUrlFor(adminUrl, emptyName);
      const matchingUrl = databaseUrlFor(adminUrl, matchingName);

      // 空库：schema 检查失败且没有创建 users/ledger，证明 HTTP 没有隐式迁移。
      const emptyResult = await runMainProcess({
        databaseUrl: emptyUrl,
        migrationsDir: MIGRATIONS_DIR,
      });
      assert(!emptyResult.success, "空库 HTTP 启动必须失败");
      const emptyState = await readDatabaseState(emptyUrl);
      assertEquals(emptyState.database, emptyName);
      assertEquals(emptyState.users, null);
      assertEquals(emptyState.ledger, null);
      await waitForNoSessions(admin, emptyName);

      const migrations = await migrateDatabase(matchingUrl);
      assert(migrations.length > 0, "匹配库必须有正式迁移");

      // 生产配置故障发生在 schema/settings 读取后，验证部分初始化失败也能回收 DB 连接。
      const configFailure = await runMainProcess({
        databaseUrl: matchingUrl,
        migrationsDir: MIGRATIONS_DIR,
        production: true,
      });
      assert(!configFailure.success, "生产配置缺失时 HTTP 启动必须失败");
      await waitForNoSessions(admin, matchingName);

      // 匹配库：启动真实 HTTP 并访问 live 探针，再通过 SIGTERM 走完整关闭路径。
      const liveResult = await runMainProcess({
        databaseUrl: matchingUrl,
        migrationsDir: MIGRATIONS_DIR,
        expectLive: true,
      });
      assert(liveResult.success, "匹配库 HTTP 启动后应能干净退出");
      await waitForNoSessions(admin, matchingName);

      // 漂移库：数据库仍为匹配状态，但发布集 SQL hash 改变，HTTP 必须在监听前拒绝。
      driftDir = await copyDrizzleAssetsWithDrift();
      const driftResult = await runMainProcess({
        databaseUrl: matchingUrl,
        migrationsDir: driftDir,
      });
      assert(!driftResult.success, "迁移资产漂移时 HTTP 启动必须失败");
      const matchingState = await readDatabaseState(matchingUrl);
      assertEquals(matchingState.database, matchingName);
      assertEquals(matchingState.users, "users");
      assertEquals(matchingState.ledger, "drizzle.__drizzle_migrations");
      assertEquals(matchingState.count, migrations.length);
      await waitForNoSessions(admin, matchingName);
    } finally {
      if (driftDir) await Deno.remove(driftDir, { recursive: true });
      for (const databaseName of [...created].reverse()) {
        if (!isOwnedDatabaseName(databaseName, prefix)) continue;
        await admin.unsafe(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      }
      await admin.end({ timeout: 5 });
    }
    // 当前测试进程仍应连接启动器声明的原始 child 库，避免子进程测试改变本 run 目标。
    assertEquals(currentDatabase, Deno.env.get("NOJ_TEST_DATABASE_NAME"));
  },
});
