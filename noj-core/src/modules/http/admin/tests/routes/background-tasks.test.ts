/**
 * 后台任务管理路由测试（P4）。
 *
 * 覆盖：管理员查看任务列表/健康/详情、非管理员 403、人工重试终态失败任务
 * （重新入队 + 审计），以及非 failed 任务重试被拒绝。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { createApp } from "../../../../../app.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { auditLogs, backgroundTasks } from "../../../../../shared/db/schema.ts";
import { createUserToken, jsonRequest } from "../../../../../../tests/helper.ts";

const db = getDb();

async function reset(): Promise<void> {
  await resetDbForTest();
  await db.execute(sql`DELETE FROM background_tasks`);
}

/** 插入一条指定状态的任务。 */
async function insertTask(
  status: "pending" | "leased" | "succeeded" | "failed",
  failureCount = 0,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(backgroundTasks).values({
    id,
    task_type: "search.index",
    target_kind: "problem",
    target_id: crypto.randomUUID(),
    dedupe_key: "problem:upsert",
    payload_version: 1,
    payload: { entity_type: "problem", entity_id: "p1", action: "upsert" },
    status,
    available_at: now,
    failure_count: failureCount,
    lease_token: status === "leased" ? "lease-token" : null,
    lease_expiry: status === "leased"
      ? new Date(Date.now() + 60_000).toISOString()
      : null,
    created_at: now,
    updated_at: now,
    finished_at: status === "succeeded" || status === "failed" ? now : null,
  });
  return id;
}

Deno.test("background-tasks 路由: 非管理员访问被拒绝", async () => {
  await reset();
  const app = createApp();
  const user = await createUserToken("user");
  const res = await jsonRequest(app, "/api/v1/admin/background-tasks", {
    headers: { Authorization: `Bearer ${user}` },
  });
  assertEquals(res.status, 403);
});

Deno.test("background-tasks 路由: 列表与健康快照", async () => {
  await reset();
  const app = createApp();
  const admin = await createUserToken("admin");
  await insertTask("pending");
  await insertTask("failed", 20);
  await insertTask("succeeded");

  const list = await jsonRequest(app, "/api/v1/admin/background-tasks", {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assertEquals(list.status, 200);
  const listBody = await list.json();
  assertEquals(listBody.total, 3);
  assertEquals(listBody.data.length, 3);
  // 列表不返回 payload 内部凭据，只返回定位与状态。
  assertEquals("payload" in listBody.data[0], false);

  const health = await jsonRequest(
    app,
    "/api/v1/admin/background-tasks/health",
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  assertEquals(health.status, 200);
  const healthBody = await health.json();
  assertEquals(healthBody.data.ready, 1);
  assertEquals(healthBody.data.failed, 1);
});

Deno.test("background-tasks 路由: 状态过滤与详情", async () => {
  await reset();
  const app = createApp();
  const admin = await createUserToken("admin");
  const failedId = await insertTask("failed", 20);
  await insertTask("pending");

  const filtered = await jsonRequest(
    app,
    "/api/v1/admin/background-tasks?status=failed",
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  assertEquals(filtered.status, 200);
  assertEquals((await filtered.json()).total, 1);

  const detail = await jsonRequest(
    app,
    `/api/v1/admin/background-tasks/${failedId}`,
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  assertEquals(detail.status, 200);
  const body = await detail.json();
  assertEquals(body.data.id, failedId);
  assertEquals(body.data.status, "failed");
  assertEquals(body.data.failure_count, 20);
});

Deno.test("background-tasks 路由: 人工重试终态失败任务并写审计", async () => {
  await reset();
  const app = createApp();
  const admin = await createUserToken("admin");
  const failedId = await insertTask("failed", 20);
  await db.delete(auditLogs);

  const res = await jsonRequest(
    app,
    `/api/v1/admin/background-tasks/${failedId}/retry`,
    { method: "POST", headers: { Authorization: `Bearer ${admin}` } },
  );
  assertEquals(res.status, 202);

  const [row] = await db.select().from(backgroundTasks);
  assertEquals(row.status, "pending");
  assertEquals(row.failure_count, 0);
  assertEquals(row.lease_token, null);

  const audits = await db.select().from(auditLogs).where(
    sql`${auditLogs.action} = 'background_task.retry'`,
  );
  assertEquals(audits.length, 1);
  assertEquals(audits[0].target_type, "background_task");
  assertEquals(audits[0].target_id, failedId);
});

Deno.test("background-tasks 路由: 非终态失败任务不能人工重试", async () => {
  await reset();
  const app = createApp();
  const admin = await createUserToken("admin");
  const pendingId = await insertTask("pending");

  const res = await jsonRequest(
    app,
    `/api/v1/admin/background-tasks/${pendingId}/retry`,
    { method: "POST", headers: { Authorization: `Bearer ${admin}` } },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  // 应用错误响应把错误码放在顶层 `code` 字段。
  assertEquals(body.code, "TASK_NOT_FAILED");

  const [row] = await db.select().from(backgroundTasks);
  assertEquals(row.status, "pending");
});
