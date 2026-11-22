/**
 * P5.3 政策/预占并发屏障：只使用本 run 的真实 PostgreSQL 与 Redis。
 *
 * 这里同时验证两个容易被“最终 revision 正确”掩盖的性质：
 * 1. 降额提交后开始的新预占读取新政策，而已冻结在 ledger 的调用仍按旧账本结算；
 * 2. 政策写入在预占边界持有共享 advisory lock 时确实处于 PostgreSQL 等待状态，
 *    释放边界后才提交，而不是依赖应用层 sleep 或偶然的调度顺序。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import IORedis from "ioredis";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  persistCallUsage,
  settleCall,
  withReservationLock,
} from "../src/accounting.ts";
import { enforceAndCount } from "../src/limits.ts";
import { TOKEN_REVOCATIONS_READY_KEY } from "../src/revocation.ts";
import {
  applyPolicyOperationTx,
  emptyPolicyCaps,
  readPolicyForReservation,
} from "../src/policy-operations.ts";
import {
  gatewayTestDatabaseUrl as databaseUrl,
  gatewayTestRedisUrl as redisUrl,
  runRedisPrefix,
} from "./integration-env.ts";

/** 该用例只需 ioredis 的三项操作，避免 Deno 下默认导出类型解析漂移。 */
type RedisConnection = {
  info(section: string): Promise<string>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    keyCount: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  quit(): Promise<unknown>;
};

interface Resources {
  admin: ReturnType<typeof createDb>;
  db: ReturnType<typeof createDb>;
  redis: RedisClient;
  connection: RedisConnection;
  schema: string;
  url: string;
  prefix: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => resolve = res);
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createResources(): Promise<Resources> {
  const admin = createDb(databaseUrl);
  const schema = "gw_policy_concurrency_" +
    crypto.randomUUID().replaceAll("-", "");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-csearch_path=" + schema);
  const db = createDb(url.toString());
  // @ts-ignore - Deno 对 ioredis 构造函数的类型解析限制
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
  }) as unknown as RedisConnection;
  const prefix = runRedisPrefix("policy-concurrency");
  const epoch = (await connection.info("server")).match(/^run_id:(.+)\r?$/m)![1]
    .trim();
  await connection.set(prefix + TOKEN_REVOCATIONS_READY_KEY, epoch);
  const redis = {
    serverId: () => Promise.resolve(epoch),
    get: (key: string) => connection.get(prefix + key),
    eval: (script: string, keys: string[], args: (string | number)[]) =>
      connection.eval(
        script,
        keys.length,
        ...keys.map((key: string) => prefix + key),
        ...args,
      ),
  } as unknown as RedisClient;
  try {
    await runMigrations(url.toString());
    return {
      admin,
      db,
      redis,
      connection,
      schema,
      url: url.toString(),
      prefix,
    };
  } catch (error) {
    await connection.quit().catch(() => undefined);
    await db.end({ timeout: 1 }).catch(() => undefined);
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`).catch(() =>
      undefined
    );
    await admin.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
}

async function cleanup(resources: Resources): Promise<void> {
  await resources.connection.quit().catch(() => undefined);
  await resources.db.end({ timeout: 1 }).catch(() => undefined);
  await resources.admin.unsafe(`DROP SCHEMA "${resources.schema}" CASCADE`)
    .catch(() => undefined);
  await resources.admin.end({ timeout: 1 }).catch(() => undefined);
}

const payload: EvalTokenPayload = {
  domain_id: "policy-school",
  attempt_id: "policy-attempt",
  protocol_version: 3,
  jti: "policy-test",
  submission_id: "policy-submission",
  problem_id: "policy-problem",
  user_id: "policy-user",
  provider_id: "policy-provider",
  allowed_models: ["policy-model"],
  iat: 0,
  exp: Number.MAX_SAFE_INTEGER,
  max_calls: 10,
  max_tokens: 1000,
};

const reserveOptions = {
  model: "policy-model",
  promptTokens: 2,
  completionTokens: 8,
  estimatedCost: 5,
  ip: "unknown",
  ttlSeconds: 60,
  userRateLimitPerMinute: 100,
  ipRateLimitPerMinute: 100,
};

Deno.test({
  name:
    "Token PG/Redis：预占 Lua 在最终边界拒绝新吊销、过期和旧世代，不增加额度",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const r = await createResources();
    try {
      for (
        const mode of [
          "token_revoked",
          "invalid_token",
          "revocations_unavailable",
        ] as const
      ) {
        const attempt = {
          ...payload,
          attempt_id: mode,
          exp: mode === "invalid_token"
            ? Math.floor(Date.now() / 1000) + 2
            : payload.exp,
        };
        const redis: RedisClient = {
          ...r.redis,
          async eval(script, keys, args) {
            // 只在身份预检查通过、SQL 预占已经登记后，实际 Lua 执行前注入竞态。
            if (JSON.parse(String(args[3] ?? "{}")).auth) {
              if (mode === "token_revoked") {
                await r.connection.set(
                  r.prefix + "llm:attempt:revoked:" + attempt.attempt_id,
                  "1",
                );
              }
              if (mode === "invalid_token") {
                await sleep(Math.max(0, attempt.exp * 1000 - Date.now() + 20));
              }
              if (mode === "revocations_unavailable") {
                await r.connection.set(
                  r.prefix + TOKEN_REVOCATIONS_READY_KEY,
                  "old-server",
                );
              }
            }
            return await r.redis.eval(script, keys, args);
          },
        };
        await assertRejects(
          () =>
            enforceAndCount(r.db, redis, attempt, {
              ...reserveOptions,
              callId: mode,
            }),
          Error,
          mode,
        );
        const [ledger] = await r
          .db`SELECT state FROM llm_call_ledger WHERE id = ${mode}`;
        assertEquals(ledger.state, "denied");
        const day = new Date().toISOString().slice(0, 10);
        assertEquals(
          await r.redis.get(
            "llm:domain:policy-school:domain::day:" + day + ":calls",
          ),
          null,
        );
      }
    } finally {
      await cleanup(r);
    }
  },
});

function usage(id: string) {
  return {
    id,
    domain_id: payload.domain_id,
    submission_id: payload.submission_id,
    attempt_id: payload.attempt_id,
    problem_id: payload.problem_id,
    user_id: payload.user_id,
    provider_id: payload.provider_id,
    model: "policy-model",
    request_messages: [],
    request_params: {},
    prompt_tokens: 2,
    completion_tokens: 3,
    total_tokens: 5,
    billed_total_tokens: 5,
    estimated_cost: 2,
    latency_ms: 1,
    status: "ok",
    prompt_hash: "policy-hash",
    created_at: new Date().toISOString(),
  };
}

const strictCaps = {
  day: { max_calls: 1, max_tokens: null, max_cost: null },
  month: { max_calls: null, max_tokens: null, max_cost: null },
};

Deno.test({
  name: "P5.3 PG/Redis：降额后新预占受限、在途账本按冻结政策结算",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createResources();
    try {
      await applyPolicyOperationTx(resources.db, {
        operationId: "policy-concurrency-initial",
        expectedRevision: 0,
        caps: strictCaps,
        actorId: "test",
      });

      await enforceAndCount(resources.db, resources.redis, payload, {
        ...reserveOptions,
        callId: "policy-inflight",
      });

      await applyPolicyOperationTx(resources.db, {
        operationId: "policy-concurrency-lower",
        expectedRevision: 1,
        caps: { ...strictCaps, day: { ...strictCaps.day, max_calls: 0 } },
        actorId: "test",
      });

      await assertRejects(
        () =>
          enforceAndCount(resources.db, resources.redis, payload, {
            ...reserveOptions,
            callId: "policy-after-lower",
          }),
        Error,
        "limit_exceeded",
      );
      const [denied] = await resources.db`
        SELECT state FROM llm_call_ledger WHERE id = 'policy-after-lower'
      `;
      assertEquals(denied.state, "denied");

      // 新政策为 0 不能追溯改写已受理调用；settlement 的 limit/inc 来自 ledger 快照。
      await persistCallUsage(
        resources.db,
        "policy-inflight",
        usage("policy-inflight"),
        5,
        2,
      );
      assertEquals(
        await settleCall(resources.db, resources.redis, "policy-inflight"),
        "ok",
      );
      const [settled] = await resources.db`
        SELECT state, settlement_result
        FROM llm_call_ledger WHERE id = 'policy-inflight'
      `;
      assertEquals(settled.state, "settled");
      assertEquals(settled.settlement_result, "ok");
    } finally {
      await cleanup(resources);
    }
  },
});

Deno.test({
  name: "P5.3 PG advisory lock：政策写入在预占边界释放前真实等待",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const resources = await createResources();
    const entered = deferred<void>();
    const release = deferred<void>();
    let writer: Promise<unknown> | undefined;
    try {
      const reservation = withReservationLock(resources.db, async (tx) => {
        await readPolicyForReservation(tx);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      const writerDb = createDb(resources.url);
      try {
        writer = applyPolicyOperationTx(writerDb, {
          operationId: "policy-advisory-writer",
          expectedRevision: 0,
          caps: emptyPolicyCaps(),
          actorId: "test",
        });

        let waiting = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const rows = await resources.admin`
            SELECT mode, granted
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid = 184789
              AND objid = 4
              AND mode = 'ExclusiveLock'
          `;
          if (rows.some((row) => row.granted === false)) {
            waiting = true;
            break;
          }
          await sleep(20);
        }
        assert(waiting, "政策写入应在共享预占 advisory lock 上等待");

        release.resolve();
        await reservation;
        const result = await writer;
        assertEquals((result as { status: string }).status, "applied");
      } finally {
        release.resolve();
        await writer?.catch(() => undefined);
        await writerDb.end({ timeout: 1 });
      }
    } finally {
      release.resolve();
      await cleanup(resources);
    }
  },
});
