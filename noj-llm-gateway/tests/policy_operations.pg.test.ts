/**
 * Gateway 实例政策持久化与管理操作的真实 PostgreSQL 测试（P5）。
 *
 * 覆盖交接文档 §5.5 的 policy_operations_test.ts 要求：
 * - 本地读取政策与 revision；null caps 表示不限；
 * - 并发修改只有一个成功，其余 409；
 * - 同 operation ID 同请求返回原结果；不同 payload 拒绝；
 * - 超时后可按 operation ID 查询持久结果；
 * - 政策、操作结果同事务提交（失败不留半套）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createInternalRouter } from "../src/routes/internal.ts";
import {
  applyPolicyOperationTx,
  readCurrentPolicy,
  readPolicyOperation,
} from "../src/policy-operations.ts";
import { testConfig } from "./helpers.ts";
import { gatewayTestDatabaseUrl as databaseUrl } from "./integration-env.ts";

/** 每个测试用独立 schema，互不干扰且退出即清理。 */
async function withSchema(
  fn: (db: ReturnType<typeof createDb>) => Promise<void>,
): Promise<void> {
  const admin = createDb(databaseUrl!);
  const schema = "gw_policy_" + crypto.randomUUID().replaceAll("-", "");
  await admin.unsafe('CREATE SCHEMA "' + schema + '"');
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", "-csearch_path=" + schema);
  const db = createDb(url.toString());
  try {
    await runMigrations(url.toString());
    await fn(db);
  } finally {
    await db.end({ timeout: 1 });
    await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end({ timeout: 1 });
  }
}

const CAPS = {
  day: { max_calls: 10, max_tokens: 1000, max_cost: 3 },
  month: { max_calls: null, max_tokens: null, max_cost: 7 },
};

function policyRequest(
  app: ReturnType<typeof createInternalRouter>,
  options: {
    operationId?: string;
    expectedRevision?: number;
    actorId?: string;
    body?: unknown;
    method?: "GET" | "PUT";
    path?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    authorization: "Bearer " + testConfig.serviceToken,
    "content-type": "application/json",
  };
  if (options.operationId) headers["X-Noj-Operation-Id"] = options.operationId;
  if (options.expectedRevision !== undefined) {
    headers["X-Noj-Expected-Revision"] = String(options.expectedRevision);
  }
  if (options.actorId) headers["X-Noj-Actor-Id"] = options.actorId;
  return app.request(options.path ?? "/internal/policy", {
    method: options.method ?? "PUT",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

Deno.test({
  name: "policy PG: 缺省空政策、写入递增 revision、旧 revision 409",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withSchema(async (db) => {
      const app = createInternalRouter({ config: testConfig, db });
      const empty = await policyRequest(app, { method: "GET" });
      assertEquals(empty.status, 200);
      assertEquals((await empty.json()).data.revision, 0);

      const applied = await policyRequest(app, {
        operationId: "op-1",
        expectedRevision: 0,
        actorId: "admin-1",
        body: CAPS,
      });
      assertEquals(applied.status, 200);
      const appliedBody = (await applied.json()).data;
      assertEquals(appliedBody.status, "applied");
      assertEquals(appliedBody.revision, 1);
      assertEquals(appliedBody.policy.day.max_calls, 10);
      assertEquals(appliedBody.policy.month.max_cost, 7);

      const after = await policyRequest(app, { method: "GET" });
      assertEquals((await after.json()).data.revision, 1);

      const stale = await policyRequest(app, {
        operationId: "op-stale",
        expectedRevision: 0,
        actorId: "admin-1",
        body: { day: { max_calls: 1 }, month: {} },
      });
      assertEquals(stale.status, 409);
      const staleBody = await stale.json();
      assertEquals(staleBody.error, "POLICY_REVISION_CONFLICT");
      assertEquals(staleBody.revision, 1);

      const policy = await readCurrentPolicy(db);
      assertEquals(policy.revision, 1);
      assertEquals(policy.day.max_calls, 10);
    });
  },
});

Deno.test({
  name: "policy PG: 同 operation ID 同请求幂等、不同请求拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withSchema(async (db) => {
      const app = createInternalRouter({ config: testConfig, db });
      const first = await policyRequest(app, {
        operationId: "op-idem",
        expectedRevision: 0,
        actorId: "admin-1",
        body: CAPS,
      });
      assertEquals(first.status, 200);
      assertEquals((await first.json()).data.revision, 1);

      // 同 ID + 同 payload：返回原结果，不重复递增 revision。
      const retry = await policyRequest(app, {
        operationId: "op-idem",
        expectedRevision: 0,
        actorId: "admin-1",
        body: CAPS,
      });
      assertEquals(retry.status, 200);
      const retryBody = (await retry.json()).data;
      assertEquals(retryBody.revision, 1);
      assertEquals(retryBody.status, "applied");
      assertEquals((await readCurrentPolicy(db)).revision, 1);

      // 同 ID + 不同 payload：拒绝。
      const conflict = await policyRequest(app, {
        operationId: "op-idem",
        expectedRevision: 0,
        actorId: "admin-1",
        body: { day: { max_calls: 999 }, month: {} },
      });
      assertEquals(conflict.status, 409);
      assertEquals(
        (await conflict.json()).error,
        "OPERATION_CONFLICT",
      );
      assertEquals((await readCurrentPolicy(db)).revision, 1);
    });
  },
});

Deno.test({
  name: "policy PG: 并发修改只有一个成功，其余冲突",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withSchema(async (db) => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          applyPolicyOperationTx(db, {
            operationId: `op-concurrent-${index}`,
            expectedRevision: 0,
            caps: {
              day: { max_calls: index + 1, max_tokens: null, max_cost: null },
              month: { max_calls: null, max_tokens: null, max_cost: null },
            },
            actorId: "admin-1",
          })),
      );
      assertEquals(
        results.filter((result) => result.status === "applied").length,
        1,
      );
      assertEquals(
        results.filter((result) => result.status === "conflict").length,
        4,
      );
      assertEquals((await readCurrentPolicy(db)).revision, 1);
    });
  },
});

Deno.test({
  name: "policy PG: 超时后按 operation ID 查询持久结果",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withSchema(async (db) => {
      const app = createInternalRouter({ config: testConfig, db });
      const applied = await policyRequest(app, {
        operationId: "op-timeout",
        expectedRevision: 0,
        actorId: "admin-1",
        body: CAPS,
      });
      assertEquals(applied.status, 200);

      const lookup = await policyRequest(app, {
        method: "GET",
        path: "/internal/operations/op-timeout",
      });
      assertEquals(lookup.status, 200);
      const lookupBody = (await lookup.json()).data;
      assertEquals(lookupBody.operation_id, "op-timeout");
      assertEquals(lookupBody.status, "applied");
      assertEquals(lookupBody.revision, 1);
      assertEquals(lookupBody.policy.day.max_calls, 10);

      // 冲突操作同样可查询。
      await policyRequest(app, {
        operationId: "op-conflict",
        expectedRevision: 0,
        actorId: "admin-1",
        body: CAPS,
      });
      const conflictLookup = await policyRequest(app, {
        method: "GET",
        path: "/internal/operations/op-conflict",
      });
      assertEquals(conflictLookup.status, 200);
      assertEquals(
        (await conflictLookup.json()).data.error_code,
        "POLICY_REVISION_CONFLICT",
      );

      const missing = await policyRequest(app, {
        method: "GET",
        path: "/internal/operations/absent",
      });
      assertEquals(missing.status, 404);

      const persisted = await readPolicyOperation(db, "op-timeout");
      assertEquals(persisted?.status, "applied");
    });
  },
});

Deno.test({
  name: "policy PG: 缺少 operation ID / 预期 revision / actor 被拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withSchema(async (db) => {
      const app = createInternalRouter({ config: testConfig, db });
      assertEquals(
        (await policyRequest(app, {
          expectedRevision: 0,
          actorId: "admin-1",
          body: CAPS,
        })).status,
        400,
      );
      assertEquals(
        (await policyRequest(app, {
          operationId: "op-x",
          actorId: "admin-1",
          body: CAPS,
        })).status,
        428,
      );
      assertEquals(
        (await policyRequest(app, {
          operationId: "op-x",
          expectedRevision: 0,
          body: CAPS,
        })).status,
        400,
      );
      assertEquals(
        (await policyRequest(app, {
          operationId: "op-x",
          expectedRevision: 0,
          actorId: "admin-1",
          body: { day: { max_calls: -1 }, month: {} },
        })).status,
        400,
      );
      // 非法请求不留下政策行与操作记录。
      const [policyCount] = await db`SELECT count(*)::int AS n FROM llm_policy`;
      assertEquals(policyCount.n, 0);
      const [opCount] =
        await db`SELECT count(*)::int AS n FROM llm_policy_operations`;
      assertEquals(opCount.n, 0);
    });
  },
});
