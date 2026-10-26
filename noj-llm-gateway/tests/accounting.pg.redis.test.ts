import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import IORedis from "ioredis";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
import type { RedisClient } from "../src/redis.ts";
import { enforceAndCount } from "../src/limits.ts";
import { TOKEN_REVOCATIONS_READY_KEY } from "../src/revocation.ts";
import {
  persistCallUsage,
  reconcileAccounting,
  recordUnknownCall,
  retrySettlements,
  settleCall,
} from "../src/accounting.ts";
import { bootstrapAccountingBaseline } from "../src/accounting-baseline.ts";
import {
  applyPolicyOperationTx,
  emptyPolicyCaps,
} from "../src/policy-operations.ts";
import {
  gatewayTestDatabaseUrl as databaseUrl,
  gatewayTestRedisUrl as redisUrl,
  runRedisPrefix,
} from "./integration-env.ts";

Deno.test({
  name:
    "账本 PG/Redis：结算后响应丢失重试不重扣、重启补算、Redis丢失重建及未知预占",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(databaseUrl!);
    const schema = "gw_accounting_" + crypto.randomUUID().replaceAll("-", "");
    await admin.unsafe('CREATE SCHEMA "' + schema + '"');
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", "-csearch_path=" + schema);
    let db = createDb(url.toString());
    // @ts-ignore - Deno 对 ioredis 构造函数的类型解析限制
    const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: 1 });
    const prefix = runRedisPrefix("accounting");
    const keys = new Set<string>();
    let loseSettlementReply = false;
    const serverGeneration = (await connection.info("server")).match(
      /^run_id:(.+)\r?$/m,
    )![1].trim();
    const restoreRevocations = async () => {
      keys.add(prefix + TOKEN_REVOCATIONS_READY_KEY);
      await connection.set(
        prefix + TOKEN_REVOCATIONS_READY_KEY,
        serverGeneration,
      );
    };
    const redis = {
      serverId: () => Promise.resolve(serverGeneration),
      get(key: string) {
        return connection.get(prefix + key);
      },
      async eval(script: string, rawKeys: string[], args: (string | number)[]) {
        const scoped = rawKeys.map((key) => prefix + key);
        for (const key of scoped) keys.add(key);
        const result = await connection.eval(
          script,
          scoped.length,
          ...scoped,
          ...args,
        );
        if (loseSettlementReply && rawKeys.at(-1)?.endsWith(":settled")) {
          loseSettlementReply = false;
          throw new Error("simulated_lost_reply");
        }
        return result;
      },
    } as RedisClient;
    const payload: EvalTokenPayload = {
      domain_id: "school-a",
      attempt_id: "attempt-a",
      protocol_version: 3,
      jti: "test",
      submission_id: "submission",
      problem_id: "source",
      user_id: "student",
      provider_id: "provider",
      allowed_models: ["model"],
      iat: 0,
      exp: Number.MAX_SAFE_INTEGER,
      max_calls: 10,
      max_tokens: 1000,
    };
    const reserve = {
      model: "model",
      promptTokens: 2,
      completionTokens: 8,
      estimatedCost: 5,
      ip: "unknown",
      ttlSeconds: 60,
      userRateLimitPerMinute: 100,
      ipRateLimitPerMinute: 100,
    };
    const usage = (id: string) => ({
      id,
      domain_id: payload.domain_id,
      submission_id: payload.submission_id,
      attempt_id: payload.attempt_id,
      problem_id: payload.problem_id,
      user_id: payload.user_id,
      provider_id: payload.provider_id,
      model: "model",
      request_messages: [],
      request_params: {},
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      billed_total_tokens: 3,
      estimated_cost: 2,
      latency_ms: 1,
      status: "ok",
      prompt_hash: "hash",
      created_at: new Date().toISOString(),
    });
    const day = new Date().toISOString().slice(0, 10);
    const domainKey = (field: string) =>
      "llm:domain:school-a:domain::day:" + day + ":" + field;
    try {
      await runMigrations(url.toString());
      await restoreRevocations();
      await enforceAndCount(db, redis, payload, {
        ...reserve,
        callId: "call-a",
      });
      await persistCallUsage(db, "call-a", usage("call-a"), 3, 2);
      loseSettlementReply = true;
      await assertRejects(
        () => settleCall(db, redis, "call-a"),
        Error,
        "simulated_lost_reply",
      );
      assertEquals(await connection.get(prefix + domainKey("tokens")), "3");
      const [pending] =
        await db`SELECT state FROM llm_call_ledger WHERE id='call-a'`;
      assertEquals(pending.state, "pending");
      // 模拟消费者重启：关闭连接、重新读取持久事实，不使用旧对象内状态。
      await db.end();
      db = createDb(url.toString());
      const otherConsumer = createDb(url.toString());
      try {
        const claimed = await Promise.all([
          retrySettlements(db, redis),
          retrySettlements(otherConsumer, redis),
        ]);
        assertEquals(claimed.reduce((total, value) => total + value, 0), 1);
      } finally {
        await otherConsumer.end();
      }
      assertEquals(await retrySettlements(db, redis), 0);
      assertEquals(await settleCall(db, redis, "call-a"), "ok");
      assertEquals(await connection.get(prefix + domainKey("tokens")), "3");
      assertEquals(await connection.get(prefix + domainKey("cost")), "2");
      const [audit] =
        await db`SELECT count(*)::integer AS count FROM llm_usage WHERE id='call-a'`;
      assertEquals(audit.count, 1);
      await enforceAndCount(db, redis, payload, {
        ...reserve,
        callId: "call-b",
      });
      await persistCallUsage(db, "call-b", usage("call-b"), 3, 2);
      await connection.del(...keys);
      await restoreRevocations();
      const reconciled = await reconcileAccounting(db, redis);
      assertEquals(reconciled.calls, 2);
      assertEquals(await connection.get(prefix + domainKey("calls")), "2");
      assertEquals(await connection.get(prefix + domainKey("tokens")), "6");
      assertEquals(await retrySettlements(db, redis), 0);
      assertEquals(await settleCall(db, redis, "call-b"), "ok");
      assertEquals(await connection.get(prefix + domainKey("tokens")), "6");
      await enforceAndCount(db, redis, payload, {
        ...reserve,
        callId: "call-unknown",
      });
      await recordUnknownCall(db, "call-unknown");
      const uncertain = await reconcileAccounting(db, redis);
      assertEquals(uncertain.unknown, 1);
      assertEquals(await connection.get(prefix + domainKey("tokens")), "16");
      const caps = {
        day: { max_calls: 1, max_tokens: null, max_cost: null },
        month: { max_calls: null, max_tokens: null, max_cost: null },
      };
      // P5：实例政策只存在于 Gateway 本地 llm_policy 行；预占在锁内读同一行，
      // 因此"降额提交之后开始的新预占"必须使用新政策。
      await applyPolicyOperationTx(db, {
        operationId: "accounting-policy-limit-1",
        expectedRevision: 0,
        caps,
        actorId: "test",
      });
      const schoolB = {
        ...payload,
        domain_id: "school-b",
        attempt_id: "attempt-b",
      };
      await enforceAndCount(db, redis, schoolB, {
        ...reserve,
        callId: "school-b-first",
      });
      const lowered = { ...caps, day: { ...caps.day, max_calls: 0 } };
      await applyPolicyOperationTx(db, {
        operationId: "accounting-policy-limit-0",
        expectedRevision: 1,
        caps: lowered,
        actorId: "test",
      });
      await assertRejects(
        () =>
          enforceAndCount(db, redis, schoolB, {
            ...reserve,
            callId: "school-b-after-lower",
          }),
        Error,
        "limit_exceeded",
      );
      const [denied] =
        await db`SELECT state FROM llm_call_ledger WHERE id='school-b-after-lower'`;
      assertEquals(denied.state, "denied");
      // 恢复空政策，避免实例级日上限影响后续恢复与结算断言。
      await applyPolicyOperationTx(db, {
        operationId: "accounting-policy-reset",
        expectedRevision: 2,
        caps: emptyPolicyCaps(),
        actorId: "test",
      });
      const [raw] =
        await db`SELECT request_messages,request_params FROM llm_usage WHERE id='call-a'`;
      assertEquals(raw.request_messages, []);
      assertEquals(raw.request_params, {});
      // 旧ready标记仍存在的Redis快照也不能放行，进程身份改变先重建。
      for (const key of keys) {
        if (!key.endsWith("llm:accounting:ready:v1")) {
          await connection.del(key);
        }
      }
      await connection.set(prefix + "llm:accounting:ready:v1", "old-server");
      await restoreRevocations();
      await enforceAndCount(db, redis, {
        ...payload,
        domain_id: "school-recovery",
        attempt_id: "after-restart",
      }, { ...reserve, callId: "after-restart" });
      assertEquals(await connection.get(prefix + domainKey("tokens")), "16");
      // 旧开发记录有相同域窗口组合时，全部约束取最严格值，新增宽松ID不能绕过。
      await db`INSERT INTO llm_quotas(id,domain_id,scope_type,scope_id,window_type,max_calls,created_at,updated_at)
        VALUES('old-local','school-c','domain','','day',2,'2026-01-01','2026-01-01'),
        ('current-local','school-c','domain','','day',0,${
        new Date().toISOString()
      },${new Date().toISOString()})`;
      await assertRejects(
        () =>
          enforceAndCount(db, redis, {
            ...payload,
            domain_id: "school-c",
            attempt_id: "attempt-c",
          }, { ...reserve, callId: "school-c-denied" }),
        Error,
        "limit_exceeded",
      );
      await db`INSERT INTO llm_quotas(id,domain_id,scope_type,scope_id,window_type,max_calls,created_at,updated_at)
        VALUES('new-loose-local','school-c','domain','','day',80,${
        new Date().toISOString()
      },${new Date().toISOString()})`;
      await assertRejects(
        () =>
          enforceAndCount(db, redis, {
            ...payload,
            domain_id: "school-c",
            attempt_id: "attempt-c-new",
          }, { ...reserve, callId: "school-c-new-id-denied" }),
        Error,
        "limit_exceeded",
      );
      // 无快照的旧窗口不能被对账静默覆盖成更低数值。
      await db`INSERT INTO llm_usage(id,domain_id,submission_id,problem_id,user_id,provider_id,model,request_messages,prompt_hash,created_at)
        VALUES('legacy-window','school-a','legacy','source','student','provider','model','[]','legacy',${
        new Date().toISOString()
      })`;
      await assertRejects(
        () => reconcileAccounting(db, redis),
        Error,
        "accounting_legacy_window_requires_baseline",
      );
      assertEquals(await connection.get(prefix + domainKey("tokens")), "16");
    } finally {
      if (keys.size) await connection.del(...keys);
      await connection.quit();
      await db.end();
      await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
      await admin.end();
    }
  },
});

Deno.test({
  name: "历史基线 PG/Redis：仅测量旧计数、缺失拒绝、DB提交失败重放不翻倍",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(databaseUrl!);
    const schema = "gw_baseline_" + crypto.randomUUID().replaceAll("-", "");
    await admin.unsafe('CREATE SCHEMA "' + schema + '"');
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", "-csearch_path=" + schema);
    const db = createDb(url.toString());
    // @ts-ignore - Deno 对 ioredis 构造函数的类型解析限制
    const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: 1 });
    const prefix = runRedisPrefix("baseline");
    const keys = new Set<string>();
    const redis = {
      get: (key: string) => connection.get(prefix + key),
      pttl: (key: string) => connection.pttl(prefix + key),
      async scan(
        cursor: string,
        pattern: string,
        count: number,
      ): Promise<[string, string[]]> {
        const [next, found] = await connection.scan(
          cursor,
          "MATCH",
          prefix + pattern,
          "COUNT",
          count,
        );
        return [next, found.map((key: string) => key.slice(prefix.length))];
      },
      eval(script: string, rawKeys: string[], args: (string | number)[]) {
        const scoped = rawKeys.map((key) => prefix + key);
        for (const key of scoped) keys.add(key);
        return connection.eval(script, scoped.length, ...scoped, ...args);
      },
    } as RedisClient;
    const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
    const global = "llm:global:month:" + month + ":calls";
    const oldUser = "llm:user:legacy-student:day:" + day + ":calls";
    const canonical =
      "llm:domain:00000000-0000-4000-8000-000000000001:user:legacy-student:day:" +
      day + ":calls";
    try {
      await runMigrations(url.toString());
      await db`INSERT INTO llm_usage(id,domain_id,submission_id,problem_id,user_id,provider_id,model,request_messages,prompt_hash,created_at)
        VALUES('old-window','00000000-0000-4000-8000-000000000001','old','source','legacy-student','provider','model','[]','hash',${
        new Date().toISOString()
      })`;
      await assertRejects(
        () => bootstrapAccountingBaseline(db, redis),
        Error,
        "accounting_baseline_counts_missing",
      );
      keys.add(prefix + global);
      keys.add(prefix + oldUser);
      await connection.set(prefix + global, "3", "EX", 3600);
      await connection.set(prefix + oldUser, "3", "EX", 3600);
      // 强制在 Lua 完成后回滚 DB，下一次必须复用已测量基线而非再次相加。
      const failCommit = Object.assign(
        (..._args: unknown[]) => Promise.resolve([]),
        {
          begin: (operation: (tx: unknown) => Promise<unknown>) =>
            db.begin(async (tx) => {
              await operation(tx);
              throw new Error("simulated_commit_failure");
            }),
        },
      ) as unknown as typeof db;
      await assertRejects(
        () => bootstrapAccountingBaseline(failCommit, redis),
        Error,
        "simulated_commit_failure",
      );
      assertEquals(await connection.get(prefix + canonical), "3");
      const recovered = await bootstrapAccountingBaseline(db, redis);
      assertEquals(recovered.replayed, true);
      assertEquals(
        (await bootstrapAccountingBaseline(db, redis)).replayed,
        true,
      );
      await reconcileAccounting(db, redis);
      assertEquals(await connection.get(prefix + global), "3");
      assertEquals(await connection.get(prefix + canonical), "3");
    } finally {
      if (keys.size) await connection.del(...keys);
      await connection.quit();
      await db.end();
      await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
      await admin.end();
    }
  },
});
