// /health/ready 就绪探针测试：注入假 DB/Redis/worker，不建立真实连接、不启动真实定时器。
import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@^1";
import type { Hono } from "hono";
import { createApp, createReadyProbe } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  ACCOUNTING_MAX_CONSECUTIVE_FAILURES,
  ACCOUNTING_STARTUP_GRACE_MS,
  type AccountingWorkerHandle,
  type AccountingWorkerStatus,
  evaluateAccountingWorkerHealth,
} from "../src/accounting.ts";
import { testConfig } from "./helpers.ts";

/** /health/ready 响应体（只声明断言需要的字段）。 */
interface ReadyBody {
  status?: string;
  service?: string;
  detail?: string[];
  checks?: Record<string, string>;
  contract_version?: number;
  time?: string;
}

/** 可计数的假数据库：默认返回一行 SELECT 1 结果。 */
interface FakeDbHandle {
  db: Db;
  queries: () => number;
}

/** 构造假数据库连接（只实现就绪探针用到的查询能力）。 */
function createFakeDb(
  query: (sql?: string) => Promise<unknown> = (sql) =>
    Promise.resolve(sql?.includes("FROM llm_policy") ? [] : [{ ok: 1 }]),
): FakeDbHandle {
  let queries = 0;
  const db = ((strings: TemplateStringsArray) => {
    queries += 1;
    return query(strings.join("?"));
  }) as unknown as Db;
  return { db, queries: () => queries };
}

/** 可计数的假 Redis：默认 ping 返回 PONG。 */
interface FakeRedisHandle {
  redis: RedisClient;
  pings: () => number;
}

/** 构造假 Redis 连接（只实现就绪探针用到的 ping）。 */
function createFakeRedis(
  ping: () => Promise<string> = () => Promise.resolve("PONG"),
): FakeRedisHandle {
  let pings = 0;
  const redis = {
    ping: () => {
      pings += 1;
      return ping();
    },
  } as unknown as RedisClient;
  return { redis, pings: () => pings };
}

/** 构造 worker 状态快照，默认视为健康。 */
function createWorkerStatus(
  overrides: Partial<AccountingWorkerStatus> = {},
): AccountingWorkerStatus {
  const now = Date.now();
  return {
    running: true,
    startedAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** 构造只提供状态读取的假 worker 句柄。 */
function createFakeWorker(
  status: AccountingWorkerStatus,
): AccountingWorkerHandle {
  return {
    stop() {
      // 注入的状态源没有定时器，无需释放。
    },
    done: Promise.resolve(),
    getStatus: () => ({ ...status }),
  };
}

/** 用假依赖创建 app；必须关闭后台任务，避免真实定时器/连接。 */
function buildApp(
  deps: {
    db?: Db;
    redis?: RedisClient;
    accountingWorker?: AccountingWorkerHandle;
  } = {},
): Hono {
  return createApp(testConfig, {
    db: deps.db === undefined ? createFakeDb().db : deps.db,
    redis: deps.redis === undefined ? createFakeRedis().redis : deps.redis,
    accountingWorker: deps.accountingWorker === undefined
      ? createFakeWorker(createWorkerStatus())
      : deps.accountingWorker,
  });
}

/** 请求 /health/ready 并解析响应体。 */
async function requestReady(
  app: Hono,
): Promise<{ status: number; body: ReadyBody; raw: string }> {
  const res = await app.request("/health/ready");
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as ReadyBody, raw };
}

Deno.test("health/ready: DB 查询、Redis ping 与记账 worker 全正常返回 200", async () => {
  const db = createFakeDb();
  const redis = createFakeRedis();
  const app = buildApp({
    db: db.db,
    redis: redis.redis,
    accountingWorker: createFakeWorker(createWorkerStatus()),
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 200);
  assertEquals(body.status, "ready");
  assertEquals(body.service, "noj-llm-gateway");
  assertEquals(body.checks, {
    database: "ok",
    policy: "ok",
    redis: "ok",
    accounting: "ok",
  });
  assertEquals(body.detail, undefined);
  // 探针必须真实访问 DB、政策表与 Redis，而不是只读常量。
  assertEquals(db.queries(), 2);
  assertEquals(redis.pings(), 1);
});

Deno.test("health/ready: 数据库查询失败返回 503(db) 且不回显敏感错误", async () => {
  const db = createFakeDb(() =>
    Promise.reject(
      new Error("connect ECONNREFUSED db.internal:5432 password=secret"),
    )
  );
  const app = buildApp({ db: db.db });

  const { status, body, raw } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.status, "not_ready");
  assertEquals(body.checks, {
    database: "error",
    policy: "error",
    redis: "ok",
    accounting: "ok",
  });
  assertEquals(body.detail, ["database_unavailable", "policy_unavailable"]);
  assertFalse(raw.includes("ECONNREFUSED"));
  assertFalse(raw.includes("password=secret"));
});

Deno.test("health/ready: Redis ping 失败返回 503(redis)", async () => {
  const redis = createFakeRedis(() =>
    Promise.reject(new Error("redis connection refused"))
  );
  const app = buildApp({ redis: redis.redis });

  const { status, body, raw } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks, {
    database: "ok",
    policy: "ok",
    redis: "error",
    accounting: "ok",
  });
  assertEquals(body.detail, ["redis_unavailable"]);
  assertFalse(raw.includes("connection refused"));
});

Deno.test("health/ready: 记账 worker 已停止返回 503(accounting)", async () => {
  const app = buildApp({
    accountingWorker: createFakeWorker(
      createWorkerStatus({ running: false }),
    ),
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks, {
    database: "ok",
    policy: "ok",
    redis: "ok",
    accounting: "error",
  });
  assertEquals(body.detail, ["accounting_worker_stopped"]);
});

Deno.test("health/ready: 记账 worker 连续失败达到阈值返回 503(accounting)", async () => {
  const app = buildApp({
    accountingWorker: createFakeWorker(
      createWorkerStatus({
        running: true,
        lastSuccessAt: null,
        consecutiveFailures: ACCOUNTING_MAX_CONSECUTIVE_FAILURES,
        lastError: "db_timeout",
      }),
    ),
  });

  const { status, body, raw } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks?.accounting, "error");
  assertEquals(body.detail, ["accounting_worker_persistent_failures"]);
  // lastError 仅供内部观测，不得进入响应体。
  assertFalse(raw.includes("db_timeout"));
});

Deno.test("health/ready: 首轮失败但仍在宽限期内重试时保持 200", async () => {
  const app = buildApp({
    accountingWorker: createFakeWorker(
      createWorkerStatus({
        running: true,
        startedAt: Date.now() - 1000,
        lastSuccessAt: null,
        consecutiveFailures: 1,
        lastError: "transient_redis_error",
      }),
    ),
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 200);
  assertEquals(body.status, "ready");
  assertEquals(body.checks?.accounting, "ok");
});

Deno.test("health/ready: 超过启动宽限期仍从未成功返回 503(accounting)", async () => {
  const app = buildApp({
    accountingWorker: createFakeWorker(
      createWorkerStatus({
        running: true,
        startedAt: Date.now() - ACCOUNTING_STARTUP_GRACE_MS - 1000,
        lastSuccessAt: null,
        consecutiveFailures: 0,
      }),
    ),
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks?.accounting, "error");
  assertEquals(body.detail, ["accounting_worker_never_succeeded"]);
});

Deno.test("health/ready: 多类依赖同时失败时 detail 区分 db/redis/accounting", async () => {
  const app = buildApp({
    db: createFakeDb(() => Promise.reject(new Error("db down"))).db,
    redis: createFakeRedis(() => Promise.reject(new Error("redis down"))).redis,
    accountingWorker: createFakeWorker(
      createWorkerStatus({ running: false }),
    ),
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks, {
    database: "error",
    policy: "error",
    redis: "error",
    accounting: "error",
  });
  assertEquals(body.detail, [
    "database_unavailable",
    "policy_unavailable",
    "redis_unavailable",
    "accounting_worker_stopped",
  ]);
});

Deno.test("health/ready: 本地持久政策不可读时返回 503(policy)", async () => {
  const app = buildApp({
    db: createFakeDb((sql) =>
      sql?.includes("FROM llm_policy")
        ? Promise.reject(new Error("policy table unavailable"))
        : Promise.resolve([{ ok: 1 }])
    ).db,
  });

  const { status, body } = await requestReady(app);

  assertEquals(status, 503);
  assertEquals(body.checks, {
    database: "ok",
    policy: "error",
    redis: "ok",
    accounting: "ok",
  });
  assertEquals(body.detail, ["policy_unavailable"]);
});

Deno.test("createApp: 缺失必需 DB/Redis/worker 时拒绝组合", () => {
  assertThrows(
    () =>
      createApp(testConfig, {
        db: null,
        redis: null,
        accountingWorker: null,
      } as never),
    Error,
    "必须",
  );
});

Deno.test("createApp: accounting worker 缺少 done 时拒绝不可排空装配", () => {
  assertThrows(
    () =>
      createApp(testConfig, {
        db: createFakeDb().db,
        redis: createFakeRedis().redis,
        accountingWorker: {
          stop() {},
          getStatus: () => createWorkerStatus(),
        },
      } as never),
    Error,
    "缺少可等待的 done",
  );
});

Deno.test("health/ready: 探针收到未配置 DB/Redis/worker 时标明未配置", async () => {
  const report = await createReadyProbe({
    db: null,
    redis: null,
    accounting: null,
  })();

  assertEquals(report.ready, false);
  assertEquals(report.checks, {
    database: "error",
    policy: "error",
    redis: "error",
    accounting: "error",
  });
  assertEquals(report.failures, [
    "database_not_configured",
    "policy_not_configured",
    "redis_not_configured",
    "accounting_worker_missing",
  ]);
});

Deno.test("health/ready: /health 与 /health/live 语义不受就绪检查影响", async () => {
  const healthy = buildApp();
  const failing = buildApp({
    db: createFakeDb(() => Promise.reject(new Error("db down"))).db,
    redis: createFakeRedis(() => Promise.reject(new Error("redis down"))).redis,
    accountingWorker: createFakeWorker(createWorkerStatus({ running: false })),
  });

  for (const app of [healthy, failing]) {
    const healthRes = await app.request("/health");
    assertEquals(healthRes.status, 200);
    const health = await healthRes.json() as ReadyBody;
    assertEquals(health.status, "ok");
    assertEquals(health.service, "noj-llm-gateway");
    assertEquals(typeof health.time, "string");

    const liveRes = await app.request("/health/live");
    assertEquals(liveRes.status, 200);
    const live = await liveRes.json() as ReadyBody;
    assertEquals(live.status, "alive");
    assertEquals(live.contract_version, 1);
  }
});

Deno.test("health/ready: 记账 worker 健康阈值（启动宽限期与连续失败）", () => {
  const now = 1_000_000;
  const base: AccountingWorkerStatus = {
    running: true,
    startedAt: now - 1000,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };

  // 启动宽限期内尚未完成首轮：视为预热中（健康）。
  assertEquals(evaluateAccountingWorkerHealth(base, now), {
    healthy: true,
    reason: null,
  });
  // 首轮失败 1 次、仍在宽限期内重试：仍健康，不因瞬时抖动摘流量。
  assertEquals(
    evaluateAccountingWorkerHealth(
      { ...base, lastError: "transient", consecutiveFailures: 1 },
      now,
    ),
    { healthy: true, reason: null },
  );
  // 连续失败达到阈值：即便仍在宽限期内也判不健康。
  assertEquals(
    evaluateAccountingWorkerHealth(
      { ...base, consecutiveFailures: ACCOUNTING_MAX_CONSECUTIVE_FAILURES },
      now,
    ),
    { healthy: false, reason: "worker_persistent_failures" },
  );
  // 宽限期结束仍从未成功：不健康（首轮对账可能卡死）。
  assertEquals(
    evaluateAccountingWorkerHealth(
      { ...base, startedAt: now - ACCOUNTING_STARTUP_GRACE_MS },
      now,
    ),
    { healthy: false, reason: "worker_never_succeeded" },
  );
  // 有过成功、连续失败未达阈值：仍健康。
  assertEquals(
    evaluateAccountingWorkerHealth({
      running: true,
      startedAt: now - 600_000,
      lastSuccessAt: now - 5000,
      lastError: "boom",
      consecutiveFailures: ACCOUNTING_MAX_CONSECUTIVE_FAILURES - 1,
    }, now),
    { healthy: true, reason: null },
  );
  // 停止后立即不健康。
  assertEquals(
    evaluateAccountingWorkerHealth({ ...base, running: false }, now),
    { healthy: false, reason: "worker_stopped" },
  );
});
