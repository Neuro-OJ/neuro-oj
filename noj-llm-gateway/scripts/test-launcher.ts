/**
 * Gateway 正式测试启动器。
 *
 * 每次运行创建唯一 PostgreSQL database；Redis 使用显式 TEST_REDIS_URL，并以
 * 本 run 的 namespace 包装测试 key。启动器不读取 .env、不使用 DATABASE_URL /
 * REDIS_URL 默认值，也不执行 FLUSHDB。子测试结束后只清理本 run 的数据库和
 * Redis key。
 */
import IORedis from "ioredis";
import { createDb } from "../src/db.ts";
import {
  assertDatabaseIdentifier,
  assertRedisPrefix,
  createRunPlan,
  databaseUrlFor,
  parseTestArgs,
  readTestEnvironment,
  redisPrefixPattern,
  resourceDisplay,
  runWithResourceCleanup,
} from "./test-launcher-logic.ts";

export {
  assertDatabaseIdentifier,
  assertRedisPrefix,
  createRunPlan,
  databaseUrlFor,
  parseTestArgs,
  readTestEnvironment,
  redisPrefixPattern,
  resourceDisplay,
  runWithResourceCleanup,
} from "./test-launcher-logic.ts";
export type {
  GatewayTestEnvironment,
  GatewayTestRunPlan,
} from "./test-launcher-logic.ts";

async function createDatabase(
  admin: ReturnType<typeof createDb>,
  name: string,
): Promise<void> {
  assertDatabaseIdentifier(name);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
}

async function dropDatabase(
  admin: ReturnType<typeof createDb>,
  name: string,
): Promise<void> {
  assertDatabaseIdentifier(name);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

function createTestRedis(url: string) {
  // @ts-ignore - ioredis 构造函数类型在 Deno 下解析受限
  const client = new IORedis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  // 所有 Redis 操作都通过 await 报错；注册 listener 避免连接失败变成未处理事件。
  client.on("error", () => undefined);
  return client;
}

/**
 * 删除一个 run 的全部 Redis key。
 *
 * 只允许启动器自己生成的 prefix，并用 SCAN + DEL 精确匹配 prefix*；
 * 不对共享 Redis 执行 FLUSHDB，也不依赖固定 DB slot。
 */
export async function cleanupRedisNamespace(
  url: string,
  prefix: string,
): Promise<void> {
  const client = createTestRedis(url);
  try {
    let cursor = "0";
    const pattern = redisPrefixPattern(prefix);
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "500",
      );
      if (keys.length > 0) {
        await client.del(...keys);
      }
      cursor = nextCursor;
    } while (cursor !== "0");
  } finally {
    await client.quit();
  }
}

async function verifyRedis(url: string): Promise<void> {
  const client = createTestRedis(url);
  try {
    const pong = await client.ping();
    if (pong !== "PONG") {
      throw new Error(`TEST_REDIS_URL ping 返回异常：${String(pong)}`);
    }
  } catch (error) {
    throw new Error(
      `无法连接 TEST_REDIS_URL（${
        resourceDisplay(url)
      }），Gateway 必需 Redis 不可用`,
      { cause: error },
    );
  } finally {
    await client.quit();
  }
}

function childEnvironment(
  base: Record<string, string>,
  databaseUrl: string,
  redisUrl: string,
  redisPrefix: string,
): Record<string, string> {
  const env = { ...base };
  // 测试子进程不能继承开发服务的默认连接变量；所有集成用例只读下面的派生值。
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  delete env.TEST_PG_ADMIN_URL;
  delete env.TEST_REDIS_URL;
  env.NOJ_GATEWAY_TEST_DATABASE_URL = databaseUrl;
  env.NOJ_GATEWAY_TEST_REDIS_URL = redisUrl;
  env.NOJ_LLM_TEST_REDIS_URL = redisUrl;
  env.NOJ_GATEWAY_TEST_REDIS_PREFIX = redisPrefix;
  return env;
}

async function runTests(
  databaseUrl: string,
  redisUrl: string,
  redisPrefix: string,
  testArgs: readonly string[],
): Promise<number> {
  const env = childEnvironment(
    Deno.env.toObject(),
    databaseUrl,
    redisUrl,
    redisPrefix,
  );
  const forwardedArgs = parseTestArgs(testArgs);
  const coverageEnabled = forwardedArgs.some((arg) =>
    arg === "--coverage" || arg.startsWith("--coverage=")
  );
  const denoTestArgs = ["test", "-A"];
  // 正式普通测试沿用快速启动模式；覆盖率任务不加 --no-check，确保 coverage
  // 门禁同时保留测试文件的类型检查，避免 CI 只跑行为而漏掉新增类型错误。
  if (!coverageEnabled) denoTestArgs.push("--no-check");
  denoTestArgs.push(...forwardedArgs, "tests");
  const child = new Deno.Command("deno", {
    args: denoTestArgs,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.success ? 0 : status.code || 1;
}

export async function main(
  args: readonly string[] = Deno.args,
): Promise<number> {
  const environment = readTestEnvironment();
  const plan = createRunPlan();
  let admin: ReturnType<typeof createDb> | undefined;
  let databaseCreated = false;
  let redisVerified = false;

  return await runWithResourceCleanup(
    async () => {
      admin = createDb(environment.pgAdminUrl);
      await verifyRedis(environment.redisUrl);
      redisVerified = true;
      await createDatabase(admin, plan.databaseName);
      databaseCreated = true;
      const databaseUrl = databaseUrlFor(
        environment.pgAdminUrl,
        plan.databaseName,
      );
      console.log(
        "[gateway-test-launcher] run=" + plan.runId + " " +
          "postgres=" + resourceDisplay(databaseUrl) + " " +
          "redis=" + resourceDisplay(environment.redisUrl),
      );
      return await runTests(
        databaseUrl,
        environment.redisUrl,
        plan.redisPrefix,
        args,
      );
    },
    async () => {
      const failures: unknown[] = [];
      if (databaseCreated && admin) {
        try {
          await dropDatabase(admin, plan.databaseName);
        } catch (error) {
          failures.push(error);
        }
      }
      if (redisVerified) {
        try {
          await cleanupRedisNamespace(
            environment.redisUrl,
            assertRedisPrefix(plan.redisPrefix),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (admin) {
        try {
          await admin.end();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Gateway 测试资源清理失败");
      }
    },
  );
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(`[gateway-test-launcher] 失败：${String(error)}`);
    Deno.exit(1);
  }
}
