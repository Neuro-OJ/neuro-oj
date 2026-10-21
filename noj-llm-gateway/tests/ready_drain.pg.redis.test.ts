/** P5.3 真实依赖就绪与关闭验收：使用启动器提供的隔离 PostgreSQL/Redis。 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../src/app.ts";
import type {
  AccountingWorkerHandle,
  AccountingWorkerStatus,
} from "../src/accounting.ts";
import { createDb, type Db } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { testConfig } from "./helpers.ts";
import {
  gatewayTestDatabaseUrl,
  gatewayTestRedisUrl,
} from "./integration-env.ts";

interface RealResources {
  admin: Db;
  db: Db;
  redis: RedisClient;
  schema: string;
}

function healthyWorker(): AccountingWorkerHandle {
  const now = Date.now();
  const status: AccountingWorkerStatus = {
    running: true,
    startedAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
  };
  return {
    stop() {},
    done: Promise.resolve(),
    getStatus: () => ({ ...status }),
  };
}

async function readReady(
  app: ReturnType<typeof createApp>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request("/health/ready");
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function closeDb(db: Db): Promise<void> {
  await db.end().catch(() => undefined);
}

async function closeRedis(redis: RedisClient): Promise<void> {
  const result = redis.quit?.();
  if (result) await result.catch(() => undefined);
}

async function createRealResources(): Promise<RealResources> {
  const admin = createDb(gatewayTestDatabaseUrl);
  const schema = "gw_ready_" + crypto.randomUUID().replaceAll("-", "");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(gatewayTestDatabaseUrl);
  url.searchParams.set("options", "-csearch_path=" + schema);
  const db = createDb(url.toString());
  const redis = createRedis(gatewayTestRedisUrl);
  try {
    await runMigrations(url.toString());
    return { admin, db, redis, schema };
  } catch (error) {
    await closeRedis(redis);
    await closeDb(db);
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`).catch(() =>
      undefined
    );
    await closeDb(admin);
    throw error;
  }
}

async function cleanupRealResources(resources: RealResources): Promise<void> {
  await closeRedis(resources.redis);
  await closeDb(resources.db);
  await resources.admin.unsafe(`DROP SCHEMA "${resources.schema}" CASCADE`)
    .catch(() => undefined);
  await closeDb(resources.admin);
}

Deno.test({
  name: "health/ready: 真实 PostgreSQL、政策表与 Redis 全部可用时 ready",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createRealResources();
    try {
      const app = createApp(testConfig, {
        db: resources.db,
        redis: resources.redis,
        accountingWorker: healthyWorker(),
      });
      const result = await readReady(app);
      assertEquals(result.status, 200, JSON.stringify(result.body));
      assertEquals(result.body.status, "ready");
      assertEquals(result.body.checks, {
        database: "ok",
        policy: "ok",
        redis: "ok",
        accounting: "ok",
      });
    } finally {
      await cleanupRealResources(resources);
    }
  },
});

Deno.test({
  name: "health/ready: 真实 PostgreSQL 连接关闭时拒绝 ready",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createRealResources();
    await resources.db.end();
    try {
      const result = await readReady(createApp(testConfig, {
        db: resources.db,
        redis: resources.redis,
        accountingWorker: healthyWorker(),
      }));
      assertEquals(result.status, 503, JSON.stringify(result.body));
      assertEquals(result.body.checks, {
        database: "error",
        policy: "error",
        redis: "ok",
        accounting: "ok",
      });
      assertEquals(result.body.detail, [
        "database_unavailable",
        "policy_unavailable",
      ]);
    } finally {
      await cleanupRealResources(resources);
    }
  },
});

Deno.test({
  name: "health/ready: 真实 Redis 连接关闭时拒绝 ready",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createRealResources();
    await resources.redis.quit?.();
    try {
      const result = await readReady(createApp(testConfig, {
        db: resources.db,
        redis: resources.redis,
        accountingWorker: healthyWorker(),
      }));
      assertEquals(result.status, 503);
      assertEquals(result.body.checks, {
        database: "ok",
        policy: "ok",
        redis: "error",
        accounting: "ok",
      });
      assertEquals(result.body.detail, ["redis_unavailable"]);
    } finally {
      await cleanupRealResources(resources);
    }
  },
});
