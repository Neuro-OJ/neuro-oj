import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { auditLogs, users } from "../../../../shared/db/schema.ts";
import { enterTestContext, leaveTestContext } from "../../../system/index.ts";
import {
  adminAudit,
  registerAudit,
  withAudit,
} from "../../services/admin-audit.ts";
import type { AuditMeta } from "../../types/admin-audit.ts";

const hasDb = true;
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

const TEST_CTX = {
  actorId: "admin-audit-test-admin",
  actorIp: "10.1.1.1",
  actorRole: "admin",
};

async function clean() {
  await resetDbForTest();
  leaveTestContext();
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: TEST_CTX.actorId,
    username: "admin-audit-test",
    email: "admin-audit-test@example.com",
    password_hash: "",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await db.delete(auditLogs);
}

Deno.test({
  name: "admin-audit: withAudit 在成功响应后写入审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clean();
    enterTestContext(TEST_CTX);

    const meta: AuditMeta = {
      action: "users.ban",
      target: () => ({ type: "user", id: "target-1" }),
      buildDetail: () => ({ action: "users.ban", reason: "spam", until: null }),
    };
    registerAudit("PATCH", "/api/v1/admin/identity/users/:id/ban", meta);

    const app = new Hono();
    app.patch(
      "/api/v1/admin/identity/users/:id/ban",
      withAudit(meta)(async (c) => {
        return await c.json({ ok: true }, 200);
      }),
    );

    const res = await app.request(
      "http://localhost/api/v1/admin/identity/users/target-1/ban",
      { method: "PATCH" },
    );
    assertEquals(res.status, 200);

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].admin_id, TEST_CTX.actorId);
    assertEquals(rows[0].action, "users.ban");
    assertEquals(rows[0].target_type, "user");
    assertEquals(rows[0].target_id, "target-1");
    assertExists(rows[0].id);
  },
});

Deno.test({
  name: "admin-audit: adminAudit 直接写入审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clean();
    enterTestContext(TEST_CTX);

    await adminAudit(
      {} as never,
      "users.unban",
      { action: "users.unban" },
      { type: "user", id: "target-2" },
    );

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "users.unban");
  },
});
