/**
 * Admin IP 黑名单路由测试（issue #102）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { ipBans, users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { jsonRequest } from "../lib/helper.ts";
import { _resetBanlistForTest } from "../../src/services/banlist.ts";
import { _resetBanCacheForTest } from "../../src/lib/banCache.ts";

const ADMIN_ID = crypto.randomUUID();
/** 时间戳使测试数据在 PG 模式下唯一，避免 static username/email 与旧数据冲突 */
const TEST_TS = Date.now();

async function freshSetup() {
  await resetDbForTest();
  _resetBanlistForTest();
  _resetBanCacheForTest();
  const db = getDb();
  await db.delete(ipBans);
  await db.delete(users).where(eq(users.id, ADMIN_ID));
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: ADMIN_ID,
    username: `test-admin-${TEST_TS}`,
    email: `test-admin-${TEST_TS}@noj.local`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "admin-blacklist route: GET /blacklist 无 token 返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/blacklist");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin-blacklist route: POST /blacklist 合法 IP 写入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    if (!Deno.env.get("JWT_SECRET")) {
      Deno.env.set(
        "JWT_SECRET",
        "test-secret-must-be-at-least-32-characters-long-xxx",
      );
    }
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const token = await signToken({ sub: ADMIN_ID, role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/blacklist", {
      method: "POST",
      body: { ip_or_cidr: "1.2.3.4", reason: "spam" },
      token,
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.ip_or_cidr, "1.2.3.4");
  },
});

Deno.test({
  name: "admin-blacklist route: POST /blacklist 0.0.0.0/0 返 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    if (!Deno.env.get("JWT_SECRET")) {
      Deno.env.set(
        "JWT_SECRET",
        "test-secret-must-be-at-least-32-characters-long-xxx",
      );
    }
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const token = await signToken({ sub: ADMIN_ID, role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/blacklist", {
      method: "POST",
      body: { ip_or_cidr: "0.0.0.0/0" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-blacklist route: POST /blacklist 非 admin 返 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    if (!Deno.env.get("JWT_SECRET")) {
      Deno.env.set(
        "JWT_SECRET",
        "test-secret-must-be-at-least-32-characters-long-xxx",
      );
    }
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const token = await signToken({ sub: "u1", role: "user" });
    const res = await jsonRequest(app, "/api/v1/admin/blacklist", {
      method: "POST",
      body: { ip_or_cidr: "1.2.3.4" },
      token,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin-blacklist route: DELETE /blacklist/:id 返 204",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    if (!Deno.env.get("JWT_SECRET")) {
      Deno.env.set(
        "JWT_SECRET",
        "test-secret-must-be-at-least-32-characters-long-xxx",
      );
    }
    const { createApp } = await import("../../src/app.ts");
    const { addIpBan } = await import("../../src/services/banlist.ts");
    const ban = await addIpBan({ ip_or_cidr: "1.2.3.4" }, ADMIN_ID);
    const app = createApp();
    const token = await signToken({ sub: ADMIN_ID, role: "admin" });
    const res = await jsonRequest(app, `/api/v1/admin/blacklist/${ban.id}`, {
      method: "DELETE",
      token,
    });
    assertEquals(res.status, 204);
  },
});
