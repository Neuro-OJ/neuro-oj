import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { initRedisForTest } from "../lib/helper.ts";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { auditLogs, users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();
await initRedisForTest();

const ADMIN_USER_ID = "audit-route-admin-uuid";
const NON_ADMIN_USER_ID = "audit-route-user-uuid";
const TS = Date.now();

/** 清空 audit_logs 并插入两个测试用户（admin + 普通用户） */
async function setupFixtureData() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();

  // 先插 admin
  await db.insert(users).values({
    id: ADMIN_USER_ID,
    username: `audit_route_admin_${TS}`,
    email: `audit-route-admin-${TS}@example.com`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();

  // 再插普通用户
  await db.insert(users).values({
    id: NON_ADMIN_USER_ID,
    username: `audit_route_user_${TS}`,
    email: `audit-route-user-${TS}@example.com`,
    password_hash: "x",
    role: "user",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();

  // 清空 audit_logs（保留 root 行为：默认排除 root）
  await db.delete(auditLogs);
}

/**
 * 发送带 Authorization 头的 GET 请求。
 * 使用 app.fetch()（而非 app.request()）以确保与 Hono 路由兼容。
 */
async function getWithToken(
  app: ReturnType<typeof createApp>,
  path: string,
  token?: string,
): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const req = new Request(`http://localhost${path}`, { headers });
  return await app.fetch(req);
}

Deno.test({
  name: "admin route: GET /admin/audit-logs 未登录返 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setupFixtureData();
    const app = createApp();
    const res = await getWithToken(app, "/api/v1/admin/audit-logs");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: GET /admin/audit-logs 非 admin 返 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setupFixtureData();
    const app = createApp();
    const userToken = await signToken({
      sub: NON_ADMIN_USER_ID,
      role: "user",
    });
    const res = await getWithToken(
      app,
      "/api/v1/admin/audit-logs",
      userToken,
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: GET /admin/audit-logs admin 返 200 + 分页",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setupFixtureData();
    const db = getDb();
    const now = new Date().toISOString();
    // 插入 3 条 admin 操作记录
    await db.insert(auditLogs).values([
      {
        id: `audit-1-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "users.ban",
        ip_address: "10.0.0.1",
        detail: { action: "users.ban", reason: "spam", until: null },
        created_at: now,
      },
      {
        id: `audit-2-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "users.unban",
        ip_address: "10.0.0.1",
        detail: { action: "users.unban" },
        created_at: now,
      },
      {
        id: `audit-3-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "problems.delete",
        target_type: "problem",
        target_id: "p-1",
        ip_address: "10.0.0.1",
        detail: {
          action: "problems.delete",
          title: "测试题",
          display_id: "P1",
        },
        created_at: now,
      },
    ]);

    const app = createApp();
    const adminToken = await signToken({
      sub: ADMIN_USER_ID,
      role: "admin",
    });
    const res = await getWithToken(
      app,
      "/api/v1/admin/audit-logs?page=1&per_page=10",
      adminToken,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.data);
    assertExists(body.pagination);
    assertEquals(body.data.length, 3);
    assertEquals(body.pagination.page, 1);
    assertEquals(body.pagination.per_page, 10);
    assertEquals(body.pagination.total, 3);
    // 验证每条 entry 都有必要字段
    for (const entry of body.data) {
      assertExists(entry.id);
      assertExists(entry.admin_id);
      assertExists(entry.action);
      assertExists(entry.created_at);
    }

    // 清理 fixture
    await db.delete(auditLogs);
  },
});

Deno.test({
  name: "admin route: GET /admin/audit-logs 按 action 筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setupFixtureData();
    const db = getDb();
    const now = new Date().toISOString();
    // 插入混合 action
    await db.insert(auditLogs).values([
      {
        id: `audit-ban-1-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "users.ban",
        ip_address: "10.0.0.2",
        detail: { action: "users.ban", reason: "x", until: null },
        created_at: now,
      },
      {
        id: `audit-ban-2-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "users.ban",
        ip_address: "10.0.0.2",
        detail: { action: "users.ban", reason: "y", until: null },
        created_at: now,
      },
      {
        id: `audit-unban-${TS}`,
        admin_id: ADMIN_USER_ID,
        action: "users.unban",
        ip_address: "10.0.0.2",
        detail: { action: "users.unban" },
        created_at: now,
      },
    ]);

    const app = createApp();
    const adminToken = await signToken({
      sub: ADMIN_USER_ID,
      role: "admin",
    });
    const res = await getWithToken(
      app,
      "/api/v1/admin/audit-logs?action=users.ban",
      adminToken,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.length, 2);
    for (const entry of body.data) {
      assertEquals(entry.action, "users.ban");
    }

    // 清理 fixture
    await db.delete(auditLogs);
  },
});
