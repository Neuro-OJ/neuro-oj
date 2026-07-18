/**
 * ban-status 端点测试（ban-status-endpoint）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { _resetBanCacheForTest } from "../../src/lib/banCache.ts";
import { _resetBanlistForTest, addIpBan } from "../../src/services/banlist.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { ipBans, userBans, users } from "../../src/db/schema.ts";
import { jsonRequest } from "../lib/helper.ts";

const HAS_SECRET = !!Deno.env.get("JWT_SECRET");
const ADMIN_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
let userToken = "";

async function freshSetup() {
  await resetDbForTest();
  _resetBanlistForTest();
  _resetBanCacheForTest();
  const db = getDb();
  await db.delete(ipBans);
  await db.delete(users).where(eq(users.id, ADMIN_ID));
  await db.delete(users).where(eq(users.id, USER_ID));

  const now = new Date().toISOString();
  await db.insert(users).values({
    id: ADMIN_ID,
    username: `ban-admin-${Date.now()}`,
    email: `ban-admin-${Date.now()}@test.local`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: USER_ID,
    username: `ban-user-${Date.now()}`,
    email: `ban-user-${Date.now()}@test.local`,
    password_hash: "x",
    role: "user",
    created_at: now,
    updated_at: now,
  });

  userToken = await signToken({ sub: USER_ID, role: "user" });
}

const app = createApp();

Deno.test({
  name: "ban-status: 未登录 + IP 未封禁 → 无封禁",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      ip: "1.2.3.4",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ip_banned, false);
    assertEquals(body.ip_ban_info, null);
    assertEquals(body.user_banned, false);
    assertEquals(body.authenticated, false);
  },
});

Deno.test({
  name: "ban-status: 未登录 + IP 被封 → ip_banned:true",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({ ip_or_cidr: "1.2.3.4", reason: "test ban" }, ADMIN_ID);
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      ip: "1.2.3.4",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ip_banned, true);
    assertEquals(body.ip_ban_info.matched_cidr, "1.2.3.4");
    assertEquals(body.ip_ban_info.reason, "test ban");
  },
});

Deno.test({
  name: "ban-status: 已登录 + 用户被封 → user_banned:true",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();
    await db.insert(userBans).values({
      id: crypto.randomUUID(),
      user_id: USER_ID,
      reason: "违规提交",
      banned_at: new Date().toISOString(),
    });
    _resetBanCacheForTest();
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      token: userToken,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user_banned, true);
    assertEquals(body.user_ban_info.reason, "违规提交");
    assertEquals(body.authenticated, true);
  },
});

Deno.test({
  name: "ban-status: 已登录 + 未封禁 → 无封禁",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      token: userToken,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user_banned, false);
    assertEquals(body.user_ban_info, null);
    assertEquals(body.authenticated, true);
  },
});

Deno.test({
  name: "ban-status: IP 封禁过期 → ip_banned:false",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({
      ip_or_cidr: "5.6.7.8",
      reason: "temp ban",
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
    }, ADMIN_ID);
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      ip: "5.6.7.8",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ip_banned, false);
  },
});

Deno.test({
  name: "ban-status: 临时封禁到期后 user_banned:false",
  ignore: !HAS_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const db = getDb();
    await db.insert(userBans).values({
      id: crypto.randomUUID(),
      user_id: USER_ID,
      reason: "temp",
      banned_until: past,
      banned_at: new Date().toISOString(),
    });
    _resetBanCacheForTest();
    const res = await jsonRequest(app, "/api/v1/auth/ban-status", {
      token: userToken,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user_banned, false);
  },
});
