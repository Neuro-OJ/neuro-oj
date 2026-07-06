import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { auditLogs, users } from "../../src/db/schema.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../src/lib/requestContext.ts";
import {
  cleanupOldAuditLogs,
  listAuditLogs,
  logAudit,
} from "../../src/services/audit-log.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

const TEST_CTX = {
  actorId: "test-admin-uuid",
  actorIp: "192.168.1.100",
  actorRole: "admin",
};

// 每个测试前重置 DB（保证 schema 已建立）并清空 audit_logs + 插入测试用户
async function cleanAuditLogs() {
  await resetDbForTest();
  leaveTestContext(); // 清理前序测试可能的 ALS 泄漏
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: TEST_CTX.actorId,
    username: "test-admin",
    email: "test-admin@example.com",
    password_hash: "",
    role: "admin",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await db.delete(auditLogs);
}

Deno.test({
  name: "audit-log: logAudit 写入字段映射",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);

    await logAudit(
      "users.ban",
      { action: "users.ban", reason: "spam", until: null },
      { type: "user", id: "target-uuid" },
    );

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].admin_id, "test-admin-uuid");
    assertEquals(rows[0].action, "users.ban");
    assertEquals(rows[0].ip_address, "192.168.1.100");
    assertEquals(rows[0].target_type, "user");
    assertEquals(rows[0].target_id, "target-uuid");
    assertEquals(rows[0].detail, {
      action: "users.ban",
      reason: "spam",
      until: null,
    });
    assertExists(rows[0].created_at);
    assertExists(rows[0].id);
  },
});

Deno.test({
  name: "audit-log: logAudit 失败仅 console.error，不抛业务错误",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);
    await logAudit("users.unban", { action: "users.unban" }, {
      type: "user",
      id: "x",
    });
  },
});

Deno.test({
  name: "audit-log: logAudit ALS 缺失不抛错（仅 console.error）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    let threw = false;
    try {
      await logAudit("users.unban", { action: "users.unban" });
    } catch (_e) {
      threw = true;
    }
    assertEquals(threw, false);

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "audit-log: cleanupOldAuditLogs 删除过期记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);

    const oldDate = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    const db = getDb();
    await db.insert(auditLogs).values({
      id: "old-1",
      admin_id: TEST_CTX.actorId,
      action: "users.unban",
      ip_address: TEST_CTX.actorIp,
      detail: { action: "users.unban" },
      created_at: oldDate,
    });
    await db.insert(auditLogs).values({
      id: "recent-1",
      admin_id: TEST_CTX.actorId,
      action: "users.unban",
      ip_address: TEST_CTX.actorIp,
      detail: { action: "users.unban" },
      created_at: recentDate,
    });

    const deleted = await cleanupOldAuditLogs(90);
    assertEquals(deleted, 1);

    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, "recent-1");
  },
});

Deno.test({
  name: "audit-log: listAuditLogs 默认排除 root (admin_id=0)",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    const db = getDb();
    await db.insert(auditLogs).values([
      {
        id: "by-root",
        admin_id: "0",
        action: "users.unban",
        ip_address: "1.1.1.1",
        detail: { action: "users.unban" },
        created_at: new Date().toISOString(),
      },
      {
        id: "by-admin",
        admin_id: "test-admin-uuid",
        action: "users.ban",
        ip_address: "1.1.1.1",
        detail: { action: "users.ban", reason: "x", until: null },
        created_at: new Date().toISOString(),
      },
    ]);

    const result = await listAuditLogs({ page: 1, perPage: 20 });
    assertEquals(result.data.length, 1);
    assertEquals(result.data[0].id, "by-admin");
    assertEquals(result.pagination.total, 1);
  },
});

Deno.test({
  name: "audit-log: listAuditLogs 按 action 筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);
    await logAudit("users.ban", {
      action: "users.ban",
      reason: "x",
      until: null,
    });
    await logAudit("users.unban", { action: "users.unban" });

    const result = await listAuditLogs({
      page: 1,
      perPage: 20,
      action: "users.ban",
    });
    assertEquals(result.data.length, 1);
    assertEquals(result.data[0].action, "users.ban");
  },
});

Deno.test({
  name: "audit-log: listAuditLogs 按时间范围筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);
    await logAudit("users.unban", { action: "users.unban" });

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const result = await listAuditLogs({
      page: 1,
      perPage: 20,
      from,
      to,
    });
    assertEquals(result.data.length, 1);
  },
});

Deno.test({
  name: "audit-log: logAudit ip_ban.create 写入字段映射",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);

    await logAudit(
      "ip_ban.create",
      {
        action: "ip_ban.create",
        ip_or_cidr: "10.0.0.0/8",
        reason: "spam",
        expires_at: null,
      },
      { type: "ip_bans", id: "ban-uuid-1" },
    );

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].admin_id, "test-admin-uuid");
    assertEquals(rows[0].action, "ip_ban.create");
    assertEquals(rows[0].target_type, "ip_bans");
    assertEquals(rows[0].target_id, "ban-uuid-1");
    assertEquals(rows[0].detail, {
      action: "ip_ban.create",
      ip_or_cidr: "10.0.0.0/8",
      reason: "spam",
      expires_at: null,
    });
    assertExists(rows[0].created_at);
    assertExists(rows[0].id);
  },
});

Deno.test({
  name: "audit-log: logAudit ip_ban.delete 写入字段映射",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanAuditLogs();
    enterTestContext(TEST_CTX);

    await logAudit(
      "ip_ban.delete",
      { action: "ip_ban.delete", ip_or_cidr: "1.2.3.4" },
      { type: "ip_bans", id: "ban-uuid-2" },
    );

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "ip_ban.delete");
    assertEquals(rows[0].target_type, "ip_bans");
    assertEquals(rows[0].target_id, "ban-uuid-2");
    assertEquals(rows[0].detail, {
      action: "ip_ban.delete",
      ip_or_cidr: "1.2.3.4",
    });
    assertExists(rows[0].created_at);
    assertExists(rows[0].id);
  },
});
