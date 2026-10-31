/**
 * noj-core 真实 PostgreSQL 测试启动器。
 *
 * 所有正式测试入口（全量、domain、shared、parallel、pg、smoke、perf、watch）
 * 都从这里取得隔离资源。启动器不读取 `.env`，也不会把现有
 * `DATABASE_URL` / `REDIS_URL` 当作测试依赖：调用方必须显式提供
 * `TEST_PG_ADMIN_URL`、`TEST_REDIS_URL`、`TEST_STORAGE_ROOT` 和足够强的
 * `JWT_SECRET`。
 * `TEST_REDIS_URL` 是模板迁移/显式 seed 使用的 bootstrap endpoint；child 测试
 * 流量使用启动器创建的独立 Redis 容器。
 *
 * 每次运行创建：
 * 1. 唯一前缀的空 PostgreSQL 模板库；
 * 2. 在模板库上执行正式迁移与显式测试种子；
 * 3. 每个分片从模板克隆的独立数据库；
 * 4. 每个 run/shard 一个带 owner label 的临时 Redis 容器；
 * 5. 位于 TEST_STORAGE_ROOT 下、只由本 run 创建的存储目录。
 *
 * finally 只清理带有本 run 前缀的数据库、并且由本 run 创建且标签匹配的 Redis 容器，
 * 以及本 run 自己创建的存储目录。数据库迁移和 seed 的实现由测试 helper
 * 显式提供，生产连接模块不再包含测试后端。
 */
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  existingTestPaths,
  type LauncherOptions,
  type LaunchMode,
  parseLauncherArgs,
} from "./test-launcher-args.ts";
import {
  assertBootstrapObservation,
  assertDatabaseIdentifier,
  createRunPlan,
  createRunStorageRoot,
  databaseUrlFor,
  isOwnedDatabaseName,
  isOwnedStorageRoot,
  makeChildEnvironment,
  readTestEnvironment,
  type RunPlan,
  shardDatabaseName,
  type TestEnvironment,
} from "./test-launcher-resources.ts";
import {
  acquireRedisLease,
  checkTestRedis,
  redisDisplay,
  type RedisLease,
} from "./test-launcher-redis.ts";
import {
  allTargetModuleTestRoots,
  testRootsForTarget,
} from "../../scripts/module-test-metadata.ts";
import { type Shard, SHARDS } from "./test-parallel-shards.ts";
import { unwrapRows } from "../src/shared/base/sql-rows.ts";

export { parseLauncherArgs } from "./test-launcher-args.ts";
export type { LauncherOptions, LaunchMode } from "./test-launcher-args.ts";
export {
  assertBootstrapObservation,
  assertDatabaseIdentifier,
  createRunPlan,
  createRunStorageRoot,
  databaseUrlFor,
  isOwnedDatabaseName,
  isOwnedStorageRoot,
  makeChildEnvironment,
  ownsRedisContainer,
  readTestEnvironment,
  redisContainerLabels,
  redisContainerRunArgs,
  shardDatabaseName,
} from "./test-launcher-resources.ts";
export type {
  BootstrapObservation,
  RedisContainerLabels,
  RunPlan,
  TestEnvironment,
} from "./test-launcher-resources.ts";

interface TestRunResources {
  environment: TestEnvironment;
  plan: RunPlan;
  admin: ReturnType<typeof postgres>;
  createdDatabases: string[];
  leases: RedisLease[];
  runRootCreated: boolean;
}

async function createDatabase(
  admin: ReturnType<typeof postgres>,
  name: string,
  template?: string,
): Promise<void> {
  assertDatabaseIdentifier(name);
  if (template) {
    assertDatabaseIdentifier(template);
    await admin.unsafe(`CREATE DATABASE "${name}" WITH TEMPLATE "${template}"`);
  } else {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  }
}

async function dropOwnedDatabases(
  admin: ReturnType<typeof postgres>,
  names: string[],
  prefix: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const name of [...names].reverse()) {
    if (!isOwnedDatabaseName(name, prefix)) continue;
    assertDatabaseIdentifier(name);
    // PostgreSQL 16 支持 WITH (FORCE)，可清理异常退出留下的连接；目标名
    // 已经通过本 run 前缀校验，不可能指向开发/生产数据库。
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (error) {
      failures.push(
        new Error(`清理测试数据库 ${name} 失败：${String(error)}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "测试数据库清理失败");
  }
}

async function withLauncherEnvironment<T>(
  values: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function childEnvironment(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
  mode: LaunchMode,
  runPerf = mode === "perf",
): Record<string, string> {
  return makeChildEnvironment(
    Deno.env.toObject(),
    resources.environment,
    resources.plan,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    mode,
    runPerf,
  );
}

async function bootstrapTemplate(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
): Promise<void> {
  const env = childEnvironment(
    resources,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    "test",
  );
  await withLauncherEnvironment(env, async () => {
    // 迁移与 seed 的唯一显式入口。该 helper 内部调用正式 Drizzle migrator，
    // 再调用 root/RBAC/workspace/image seed；它不使用手写测试 DDL。
    const helper = await import("../tests/helpers/db.ts");
    const connection = await import("../src/shared/db/connection.ts");
    let operationError: unknown;
    try {
      await helper.setupSchemaForTest();
      const result = await connection.getDb().execute(
        sql`SELECT current_database() AS current_database,
          to_regclass('users') AS users_table`,
      );
      const rows = unwrapRows<{
        current_database: string;
        users_table: string | null;
      }>(result as never);
      const row = rows[0];
      assertBootstrapObservation({
        currentDatabase: String(row?.current_database ?? ""),
        usersTable: row?.users_table ?? null,
      }, databaseName);
    } catch (error) {
      operationError = error;
    }
    let closeError: unknown;
    try {
      await connection.closeDbForShutdown();
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        "模板库迁移/seed 失败且数据库连接清理失败",
      );
    }
    if (operationError !== undefined) throw operationError;
    if (closeError !== undefined) {
      throw new Error(`模板库数据库连接关闭失败：${String(closeError)}`, {
        cause: closeError,
      });
    }
  });
}

async function prepareResources(
  environment: TestEnvironment,
  plan: RunPlan,
): Promise<TestRunResources> {
  const resources: TestRunResources = {
    environment,
    plan,
    admin: postgres(environment.pgAdminUrl, { max: 1 }),
    createdDatabases: [],
    leases: [],
    runRootCreated: false,
  };
  try {
    await createRunStorageRoot(plan);
    resources.runRootCreated = true;
    await createDatabase(resources.admin, plan.templateDatabase);
    resources.createdDatabases.push(plan.templateDatabase);

    // TEST_REDIS_URL 是模板迁移和显式 seed 实际使用的 bootstrap endpoint；
    // child 分片随后各自取得专用 Redis 容器，不会对这个 endpoint 做 FLUSHDB。
    await checkTestRedis(environment.redisUrl);
    await Deno.mkdir(`${plan.storageRoot}/bootstrap-storage`, {
      recursive: true,
    });
    await bootstrapTemplate(
      resources,
      plan.templateDatabase,
      databaseUrlFor(environment.pgAdminUrl, plan.templateDatabase),
      environment.redisUrl,
      `${plan.storageRoot}/bootstrap-storage`,
    );
    return resources;
  } catch (error) {
    try {
      await cleanupResources(resources);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "测试资源初始化失败且清理未完全成功",
      );
    }
    throw error;
  }
}

async function cloneShard(
  resources: TestRunResources,
  shard: Shard,
): Promise<
  {
    databaseName: string;
    databaseUrl: string;
    redis: RedisLease;
    storageDir: string;
  }
> {
  const databaseName = shardDatabaseName(resources.plan, shard.name);
  await createDatabase(
    resources.admin,
    databaseName,
    resources.plan.templateDatabase,
  );
  resources.createdDatabases.push(databaseName);
  const redis = await acquireRedisLease(resources.plan, shard.name);
  resources.leases.push(redis);
  const storageDir = `${resources.plan.storageRoot}/${shard.name}`;
  await Deno.mkdir(storageDir, { recursive: true });
  return {
    databaseName,
    databaseUrl: databaseUrlFor(resources.environment.pgAdminUrl, databaseName),
    redis,
    storageDir,
  };
}

function pathsFor(options: LauncherOptions): string[] {
  switch (options.mode) {
    case "domain":
      return [
        "tests/00_migrate_test.ts",
        "tests/seed_bootstrap_admin_test.ts",
        ...testRootsForTarget(options.domain!),
      ];
    case "shared":
      return [
        "tests/00_migrate_test.ts",
        "tests/seed_bootstrap_admin_test.ts",
        "tests/shared",
        "tests/data",
        "tests/app.test.ts",
        "tests/db",
        "tests/routes",
        "tests/scripts",
        "tests/security-headers.test.ts",
        "tests/types_safety_test.ts",
        "tests/defensive-patterns_test.ts",
        "tests/smoke.test.ts",
      ];
    case "smoke":
      return ["tests/00_migrate_test.ts", "tests/smoke.test.ts"];
    case "perf":
      return [
        "tests/00_migrate_test.ts",
        "tests/perf",
        "src/modules/read-models/search/tests/perf",
        "src/modules/education/tests/perf",
      ];
    case "test":
    case "pg":
    case "watch":
      return ["tests", ...allTargetModuleTestRoots()];
    case "parallel":
      return [];
  }
}

async function runDenoTests(
  resources: TestRunResources,
  databaseName: string,
  databaseUrl: string,
  redisUrl: string,
  storageDir: string,
  mode: LaunchMode,
  paths: string[],
  testArgs: string[],
  runPerf = mode === "perf",
): Promise<number> {
  const env = childEnvironment(
    resources,
    databaseName,
    databaseUrl,
    redisUrl,
    storageDir,
    mode,
    runPerf,
  );
  const args = [
    "test",
    "-A",
    "--no-check",
    "--preload=tests/preload.ts",
    ...(mode === "watch" ? ["--watch"] : []),
    ...paths,
    ...testArgs,
  ];
  console.log(
    `[test-launcher] ${mode} database=${databaseName} redis=${
      redisDisplay(redisUrl)
    } ` +
      `storage=${storageDir}`,
  );
  const child = new Deno.Command("deno", {
    args,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.success ? 0 : status.code || 1;
}

async function cleanupResources(resources: TestRunResources): Promise<void> {
  const failures: unknown[] = [];
  for (const lease of [...resources.leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      failures.push(
        new Error(
          `清理 Redis 容器 ${lease.containerId}（${
            redisDisplay(lease.url)
          }）失败：${String(error)}`,
          { cause: error },
        ),
      );
    }
  }
  resources.leases = [];
  try {
    await dropOwnedDatabases(
      resources.admin,
      resources.createdDatabases,
      resources.plan.prefix,
    );
  } catch (error) {
    failures.push(error);
  }
  resources.createdDatabases = [];
  try {
    await resources.admin.end();
  } catch (error) {
    failures.push(
      new Error(`测试 admin 连接关闭失败：${String(error)}`, { cause: error }),
    );
  }
  if (resources.runRootCreated) {
    const root = resources.plan.storageRoot;
    if (isOwnedStorageRoot(root, resources.plan.prefix)) {
      try {
        await Deno.remove(root, { recursive: true });
      } catch (error) {
        failures.push(
          new Error(`清理测试存储目录 ${root} 失败：${String(error)}`, {
            cause: error,
          }),
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "测试资源清理失败");
  }
}

async function run(options: LauncherOptions): Promise<number> {
  if (options.dryRun) {
    const requestedPaths = pathsFor(options);
    const paths = options.mode === "parallel"
      ? requestedPaths
      : await existingTestPaths(requestedPaths);
    const shards = options.mode === "parallel"
      ? SHARDS.slice(0, options.shardCount).map((shard) => ({
        name: shard.name,
        dirs: shard.dirs,
      }))
      : [];
    console.log(
      JSON.stringify(
        { mode: options.mode, runPerf: options.runPerf, paths, shards },
        null,
        2,
      ),
    );
    return 0;
  }

  const environment = readTestEnvironment();
  const plan = createRunPlan(environment.storageRoot);
  console.log(
    `[test-launcher] run=${plan.runId} prefix=${plan.prefix} ` +
      `admin=${new URL(environment.pgAdminUrl).hostname}`,
  );
  const resources = await prepareResources(environment, plan);
  let exitCode = 0;
  try {
    if (options.mode === "parallel") {
      const selected = SHARDS.slice(0, options.shardCount);
      const children = [];
      for (const shard of selected) {
        children.push(await cloneShard(resources, shard));
      }
      const statuses = await Promise.all(
        children.map((child, index) => {
          const shard = selected[index]!;
          return existingTestPaths([
            "tests/00_migrate_test.ts",
            ...shard.dirs.filter((dir) => dir !== "tests/00_migrate_test.ts"),
          ]).then((paths) =>
            runDenoTests(
              resources,
              child.databaseName,
              child.databaseUrl,
              child.redis.url,
              child.storageDir,
              "parallel",
              paths,
              options.testArgs,
              false,
            )
          );
        }),
      );
      exitCode = statuses.some((status) => status !== 0) ? 1 : 0;
    } else {
      const child = await cloneShard(resources, {
        name: "single",
        dirs: pathsFor(options),
      });
      const paths = await existingTestPaths(pathsFor(options));
      exitCode = await runDenoTests(
        resources,
        child.databaseName,
        child.databaseUrl,
        child.redis.url,
        child.storageDir,
        options.mode,
        paths,
        options.testArgs,
        options.runPerf,
      );
    }
  } finally {
    await cleanupResources(resources);
  }
  return exitCode;
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const options = parseLauncherArgs(args);
  return await run(options);
}

if (import.meta.main) {
  try {
    const code = await main();
    Deno.exit(code);
  } catch (error) {
    console.error(`[test-launcher] 失败：${String(error)}`);
    Deno.exit(1);
  }
}
