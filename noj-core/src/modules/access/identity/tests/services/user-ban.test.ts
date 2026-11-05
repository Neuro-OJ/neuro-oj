/**
 * 用户封禁/解封审计日志测试（issue #101 + #102）。
 *
 * 验证 banUser / unbanUser 在 service 层正确写入 audit_logs。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { auditLogs, userBans, users } from "../../../../../shared/db/schema.ts";
import { banUser, unbanUser } from "../../index.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../../../platform/system/index.ts";

const ADMIN_ID = crypto.randomUUID();
const ADMIN2_ID = crypto.randomUUID();
const TARGET_ID = crypto.randomUUID();
const TS = Date.now();

async function freshSetup() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();

  // 清空可能残留的数据
  await db.delete(auditLogs);
  await db.delete(userBans);
  await db.delete(users).where(eq(users.id, ADMIN_ID));
  await db.delete(users).where(eq(users.id, ADMIN2_ID));
  await db.delete(users).where(eq(users.id, TARGET_ID));

  // 插入两个管理员（第二个确保 ban 操作不触发"最后一个 admin"保护）。
  // 操作者身份由锁内重读 users.role 判定，因此这里必须写入真实平台角色。
  await db.insert(users).values({
    id: ADMIN_ID,
    username: `ban-admin-${TS}`,
    email: `ban-admin-${TS}@test.local`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: ADMIN2_ID,
    username: `ban-admin2-${TS}`,
    email: `ban-admin2-${TS}@test.local`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  });
  // 插入一个普通用户作为封禁目标
  await db.insert(users).values({
    id: TARGET_ID,
    username: `ban-target-${TS}`,
    email: `ban-target-${TS}@test.local`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "user-ban audit: banUser 写入审计日志 users.ban",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();

    enterTestContext({
      actorId: ADMIN_ID,
      actorIp: "10.0.0.1",
      actorRole: "admin",
    });
    try {
      await banUser(TARGET_ID, "违规行为", null, ADMIN_ID);

      const logs = await db.select().from(auditLogs);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].admin_id, ADMIN_ID);
      assertEquals(logs[0].action, "users.ban");
      assertEquals(logs[0].target_type, "users");
      assertEquals(logs[0].target_id, TARGET_ID);
      assertEquals(logs[0].ip_address, "10.0.0.1");
      assertEquals(logs[0].detail, {
        action: "users.ban",
        reason: "违规行为",
        until: null,
        scope: "platform",
      });
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "user-ban audit: banUser 带过期时间的审计日志",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();

    const future = new Date(Date.now() + 86400_000).toISOString();

    enterTestContext({
      actorId: ADMIN_ID,
      actorIp: "10.0.0.1",
      actorRole: "admin",
    });
    try {
      await banUser(TARGET_ID, "临时封禁", future, ADMIN_ID);

      const logs = await db.select().from(auditLogs);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].action, "users.ban");
      assertEquals((logs[0].detail as Record<string, unknown>).until, future);
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "user-ban audit: unbanUser 写入审计日志 users.unban",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();

    // 先封禁
    await banUser(TARGET_ID, "封禁测试", null, ADMIN_ID);
    await db.delete(auditLogs); // 清除 ban 的审计日志，只测 unban

    enterTestContext({
      actorId: ADMIN_ID,
      actorIp: "10.0.0.2",
      actorRole: "admin",
    });
    try {
      await unbanUser(TARGET_ID, ADMIN_ID);

      const logs = await db.select().from(auditLogs);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].admin_id, ADMIN_ID);
      assertEquals(logs[0].action, "users.unban");
      assertEquals(logs[0].target_type, "users");
      assertEquals(logs[0].target_id, TARGET_ID);
      assertEquals(logs[0].ip_address, "10.0.0.2");
      assertEquals(logs[0].detail, { action: "users.unban" });
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "user-ban scope: 社区封禁不解除平台封禁，解封解除全部",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();

    enterTestContext({
      actorId: ADMIN_ID,
      actorIp: "10.0.0.3",
      actorRole: "admin",
    });
    try {
      await banUser(TARGET_ID, "平台封禁", null, ADMIN_ID, "platform");
      await banUser(TARGET_ID, "社区封禁", null, ADMIN_ID, "social");

      const rows = await db.select().from(userBans)
        .where(eq(userBans.user_id, TARGET_ID));
      const activeOf = (scope: string) =>
        rows.filter((row) => row.scope === scope && row.unbanned_at === null);
      assertEquals(
        activeOf("platform").length,
        1,
        "社区封禁不得解除仍在生效的平台封禁",
      );
      assertEquals(activeOf("social").length, 1);

      // 同范围重复封禁只保留最新一条活跃记录（旧记录被关闭）
      await banUser(TARGET_ID, "社区封禁二", null, ADMIN_ID, "social");
      const afterSecond = await db.select().from(userBans)
        .where(eq(userBans.user_id, TARGET_ID));
      assertEquals(
        afterSecond.filter((row) =>
          row.scope === "social" && row.unbanned_at === null
        ).length,
        1,
      );
      assertEquals(
        afterSecond.filter((row) =>
          row.scope === "platform" && row.unbanned_at === null
        ).length,
        1,
      );

      // 解封的语义是解除该用户全部限制（管理员手动解封）
      await unbanUser(TARGET_ID, ADMIN_ID);
      const afterUnban = await db.select().from(userBans)
        .where(eq(userBans.user_id, TARGET_ID));
      assertEquals(
        afterUnban.every((row) => row.unbanned_at !== null),
        true,
        "解封应关闭所有范围的活跃封禁",
      );
    } finally {
      leaveTestContext();
    }
  },
});
