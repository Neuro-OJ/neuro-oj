/**
 * IP 黑名单 service 测试（issue #102）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { ipBans, users } from "../../src/db/schema.ts";
import {
  _resetBanlistForTest,
  addIpBan,
  getBannedRanges,
  listIpBans,
  removeIpBan,
} from "../../src/services/banlist.ts";
import { _resetBanCacheForTest } from "../../src/lib/banCache.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/lib/errors.ts";

const ADMIN_ID = crypto.randomUUID();
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
  name: "banlist service: addIpBan 插入合法 IP 成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const ban = await addIpBan(
      { ip_or_cidr: "1.2.3.4", reason: "spam" },
      ADMIN_ID,
    );
    assertEquals(ban.ip_or_cidr, "1.2.3.4");
    assertEquals(ban.reason, "spam");
    assertEquals(ban.created_by, ADMIN_ID);

    // 验证 DB
    const db = getDb();
    const rows = await db.select().from(ipBans).where(eq(ipBans.id, ban.id));
    assertEquals(rows.length, 1);
  },
});

Deno.test({
  name: "banlist service: addIpBan 拒绝 0.0.0.0/0（封禁全网）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => addIpBan({ ip_or_cidr: "0.0.0.0/0" }, ADMIN_ID),
      ValidationError,
      "不能是 0.0.0.0/0",
    );
  },
});

Deno.test({
  name: "banlist service: addIpBan 拒绝非法 CIDR",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => addIpBan({ ip_or_cidr: "abc" }, ADMIN_ID),
      ValidationError,
      "IP/CIDR 格式无效",
    );
  },
});

Deno.test({
  name: "banlist service: addIpBan 拒绝重复 IP",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({ ip_or_cidr: "1.2.3.4" }, ADMIN_ID);
    await assertRejects(
      () => addIpBan({ ip_or_cidr: "1.2.3.4" }, ADMIN_ID),
      ConflictError,
      "已存在",
    );
  },
});

Deno.test({
  name: "banlist service: addIpBan 拒绝非法 expires_at",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () =>
        addIpBan({ ip_or_cidr: "5.6.7.8", expires_at: "not-iso" }, ADMIN_ID),
      ValidationError,
      "ISO 8601",
    );
  },
});

Deno.test({
  name: "banlist service: listIpBans 分页 + 模糊搜索",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({ ip_or_cidr: "10.0.0.1" }, ADMIN_ID);
    await addIpBan({ ip_or_cidr: "10.0.0.2" }, ADMIN_ID);
    await addIpBan({ ip_or_cidr: "192.168.1.0/24" }, ADMIN_ID);

    const all = await listIpBans({ page: 1, perPage: 10 });
    assertEquals(all.data.length, 3);
    assertEquals(all.pagination.total, 3);

    const filtered = await listIpBans({
      page: 1,
      perPage: 10,
      keyword: "10.0",
    });
    assertEquals(filtered.data.length, 2);
  },
});

Deno.test({
  name: "banlist service: removeIpBan 删除存在条目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const ban = await addIpBan({ ip_or_cidr: "1.2.3.4" }, ADMIN_ID);
    await removeIpBan(ban.id, ADMIN_ID);

    const all = await listIpBans({ page: 1, perPage: 10 });
    assertEquals(all.data.length, 0);
  },
});

Deno.test({
  name: "banlist service: removeIpBan 不存在返 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => removeIpBan("non-existent-id", ADMIN_ID),
      NotFoundError,
      "不存在",
    );
  },
});

Deno.test({
  name: "banlist service: getBannedRanges 返回所有 ip_or_cidr",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({ ip_or_cidr: "1.2.3.4" }, ADMIN_ID);
    await addIpBan({ ip_or_cidr: "10.0.0.0/8" }, ADMIN_ID);

    const ranges = await getBannedRanges();
    assertEquals(ranges.length, 2);
    assertEquals(ranges.includes("1.2.3.4"), true);
    assertEquals(ranges.includes("10.0.0.0/8"), true);
  },
});

Deno.test({
  name: "banlist service: getBannedRanges 过期条目被过滤",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({
      ip_or_cidr: "5.6.7.8",
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
    }, ADMIN_ID);
    await addIpBan({ ip_or_cidr: "9.10.11.12" }, ADMIN_ID);

    const ranges = await getBannedRanges();
    assertEquals(ranges.includes("5.6.7.8"), false);
    assertEquals(ranges.includes("9.10.11.12"), true);
  },
});

Deno.test({
  name: "banlist service: getBannedIpDetail 返回匹配条目详情",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await addIpBan({ ip_or_cidr: "192.168.1.1", reason: "bot" }, ADMIN_ID);
    const { getBannedIpDetail } = await import("../../src/services/banlist.ts");

    const detail = await getBannedIpDetail("192.168.1.1");
    assertEquals(detail?.matched_cidr, "192.168.1.1");
    assertEquals(detail?.reason, "bot");
  },
});

Deno.test({
  name: "banlist service: getBannedIpDetail 不存在返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const { getBannedIpDetail } = await import("../../src/services/banlist.ts");
    const detail = await getBannedIpDetail("9.9.9.9");
    assertEquals(detail, null);
  },
});
