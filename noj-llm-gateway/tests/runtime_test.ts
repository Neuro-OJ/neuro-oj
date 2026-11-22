/** Gateway 后台任务、真实 socket 排空与资源依赖测试。 */
import { assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@^1";
import type { Db } from "../src/db.ts";
import {
  type AccountingWorkerHandle,
  startAccountingWorker,
} from "../src/accounting.ts";
import { startUsageRetention } from "../src/usage.ts";
import { createDb, type Db as PostgresDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { assertGatewayDependencies } from "../src/runtime.ts";
import {
  gatewayTestDatabaseUrl as integrationDatabaseUrl,
  gatewayTestRedisUrl as integrationRedisUrl,
  runRedisPrefix,
} from "./integration-env.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => resolve = res);
  return { promise, resolve };
}

Deno.test("usage retention: stop 后 done 等待在途清理完成", async () => {
  const inFlight = deferred<unknown[]>();
  let dbCalled = false;
  const db = (() => {
    dbCalled = true;
    return inFlight.promise;
  }) as unknown as Db;
  const redis = {
    setNx: () => Promise.resolve(true),
  } as unknown as RedisClient;

  const task = startUsageRetention(db, redis, 90);
  await Promise.resolve();
  assertEquals(dbCalled, true);
  let done = false;
  task.done.then(() => done = true);
  task.stop();
  await Promise.resolve();
  assertEquals(done, false);

  inFlight.resolve([]);
  await task.done;
  assertEquals(done, true);
});

Deno.test("accounting worker: stop 后 done 等待在途对账完成", async () => {
  const serverId = deferred<string>();
  const redis = {
    serverId: () => serverId.promise,
    get: () => Promise.resolve(null),
    eval: () => Promise.resolve("ok"),
  } as unknown as RedisClient;
  const db = (() => Promise.resolve([])) as unknown as Db;

  const worker = startAccountingWorker(db, redis) as AccountingWorkerHandle & {
    done: Promise<void>;
  };
  let done = false;
  worker.done.then(() => done = true);
  worker.stop();
  await Promise.resolve();
  assertEquals(done, false);

  serverId.resolve("test-server");
  await worker.done;
  assertEquals(done, true);
  assertEquals(worker.getStatus().running, false);
});

Deno.test("Gateway HTTP: shutdown 停止新连接并排空真实流式 response body", async () => {
  const bodyReleased = deferred<void>();
  const server = Deno.serve({ port: 0 }, () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("prefix"));
          bodyReleased.promise.then(() => {
            controller.enqueue(new TextEncoder().encode("suffix"));
            controller.close();
          });
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  });
  const port = (server.addr as Deno.NetAddr).port;
  const url = `http://127.0.0.1:${port}/stream`;
  let shutdown: Promise<void> | undefined;
  try {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value), "prefix");

    let shutdownFinished = false;
    shutdown = server.shutdown().then(() => {
      shutdownFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertFalse(shutdownFinished);

    // shutdown 已停止监听，新连接不会等到旧 stream 排空后才被接受。
    await assertRejects(
      () => fetch(url, { signal: AbortSignal.timeout(500) }),
      Error,
    );

    bodyReleased.resolve();
    await shutdown;
    shutdown = undefined;
    const second = await reader.read();
    assertEquals(new TextDecoder().decode(second.value), "suffix");
    assertEquals((await reader.read()).done, true);
  } finally {
    bodyReleased.resolve();
    if (shutdown) await shutdown.catch(() => {});
    else await server.shutdown().catch(() => {});
  }
});

Deno.test("Gateway 依赖检查：DB/Redis 任一不可用时失败而不是继续监听", async () => {
  const db = (() => Promise.reject(new Error("db refused"))) as unknown as Db;
  const redis = {
    ping: () => Promise.reject(new Error("redis refused")),
  } as unknown as RedisClient;
  await assertRejects(
    () => assertGatewayDependencies(db, redis),
    AggregateError,
    "必需依赖检查失败",
  );
});

interface IsolatedRuntimeResources {
  db: PostgresDb;
  redis: RedisClient;
  cleanup: () => Promise<void>;
}

/** 在专用 schema 与随机 Redis 前缀中运行 worker 生命周期测试。 */
async function createIsolatedRuntimeResources(): Promise<
  IsolatedRuntimeResources
> {
  const admin = createDb(integrationDatabaseUrl!);
  const schema = "gw_runtime_" + crypto.randomUUID().replaceAll("-", "");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(integrationDatabaseUrl!);
  databaseUrl.searchParams.set("options", "-csearch_path=" + schema);
  const db = createDb(databaseUrl.toString());
  const baseRedis = createRedis(integrationRedisUrl!);
  const prefix = runRedisPrefix("runtime");
  const readyKey = prefix + "llm:accounting:ready:v1";
  const redis = {
    serverId: () => baseRedis.serverId!(),
    get: (key: string) => baseRedis.get!(prefix + key),
    eval: (script: string, keys: string[], args: (string | number)[]) =>
      baseRedis.eval!(script, keys.map((key: string) => prefix + key), args),
  } as unknown as RedisClient;
  try {
    await runMigrations(databaseUrl.toString());
  } catch (error) {
    await baseRedis.quit?.();
    await db.end();
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    db,
    redis,
    cleanup: async () => {
      await baseRedis.eval(
        "return redis.call('DEL', KEYS[1])",
        [readyKey],
        [],
      );
      await baseRedis.quit?.();
      await db.end();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

Deno.test({
  name: "accounting worker: 真实 PG 慢在途操作在 done 前完成",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createIsolatedRuntimeResources();
    const entered = deferred<void>();
    const release = deferred<void>();
    const realBegin = resources.db.begin.bind(resources.db) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const slowDb = ((...args: unknown[]) =>
      (resources.db as unknown as (...args: unknown[]) => unknown)(
        ...args,
      )) as unknown as PostgresDb;
    (slowDb as unknown as { begin: (...args: unknown[]) => Promise<unknown> })
      .begin = (...args) => {
        entered.resolve();
        return release.promise.then(() =>
          realBegin(...args)
        );
      };
    const worker = startAccountingWorker(slowDb, resources.redis);
    try {
      await entered.promise;
      let done = false;
      worker.done.then(() => done = true);
      worker.stop();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertFalse(done);
      release.resolve();
      await worker.done;
      assertEquals(worker.getStatus().running, false);
    } finally {
      release.resolve();
      await worker.done.catch(() => {});
      await resources.cleanup();
    }
  },
});

Deno.test({
  name: "accounting worker: 真实 Redis 慢在途操作在 done 前完成",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createIsolatedRuntimeResources();
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstEval = true;
    const slowRedis = {
      serverId: () => resources.redis.serverId!(),
      get: (key: string) => resources.redis.get!(key),
      eval: async (
        script: string,
        keys: string[],
        args: (string | number)[],
      ) => {
        if (firstEval) {
          firstEval = false;
          entered.resolve();
          await release.promise;
        }
        return await resources.redis.eval!(script, keys, args);
      },
    } as unknown as RedisClient;
    const worker = startAccountingWorker(resources.db, slowRedis);
    try {
      await entered.promise;
      let done = false;
      worker.done.then(() => done = true);
      worker.stop();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertFalse(done);
      release.resolve();
      await worker.done;
      assertEquals(worker.getStatus().running, false);
    } finally {
      release.resolve();
      await worker.done.catch(() => {});
      await resources.cleanup();
    }
  },
});
