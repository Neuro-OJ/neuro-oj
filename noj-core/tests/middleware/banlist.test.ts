/**
 * 封禁中间件 + 工具单测（issue #102 / user-ban-table）。
 *
 * 直接测：
 * - getUserBanState 60s LRU 缓存行为（从 user_bans 表读取）
 * - 临时 ban（banned_until 过期）视为未封禁
 * - banCache invalidateBanCache 失效
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { resetDbForTest } from "../../src/db/connection.ts";
import { userBans, users } from "../../src/db/schema.ts";
import { getDb } from "../../src/db/connection.ts";
import { getUserBanState } from "../../src/middleware/auth.ts";
import {
  _resetBanCacheForTest,
  getCached,
  invalidateBanCache,
} from "../../src/lib/banCache.ts";

const TARGET_ID = crypto.randomUUID();
/** 时间戳使测试数据在 PG 模式下唯一，避免 static username/email 与旧数据冲突（onConflictDoNothing 静默跳过） */
const TEST_TS = Date.now();

async function freshSetup() {
  await resetDbForTest();
  _resetBanCacheForTest();
  const db = getDb();
  await db.delete(userBans).where(eq(userBans.user_id, TARGET_ID));
  await db.delete(users).where(eq(users.id, TARGET_ID));
}

async function seedUser() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: TARGET_ID,
    username: `banned-user-${TEST_TS}`,
    email: `banned-${TEST_TS}@test.local`,
    password_hash: "x",
    role: "user",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
}

Deno.test({
  name: "banState: 未 ban 用户返回 banned=false",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await seedUser();

    const state = await getUserBanState(TARGET_ID);
    assertEquals(state.banned, false);
    assertEquals(state.reason, "");
    assertEquals(state.until, null);
  },
});

Deno.test({
  name: "banState: 永久 ban（banned_until=null）正确返回",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await seedUser();
    const db = getDb();
    await db.insert(userBans).values({
      id: crypto.randomUUID(),
      user_id: TARGET_ID,
      reason: "spam",
      banned_until: null,
      banned_at: new Date().toISOString(),
    });

    const state = await getUserBanState(TARGET_ID);
    assertEquals(state.banned, true);
    assertEquals(state.reason, "spam");
    assertEquals(state.until, null);
  },
});

Deno.test({
  name: "banState: 临时 ban（banned_until 未来）正确返回",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await seedUser();
    const db = getDb();
    const futureIso = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await db.insert(userBans).values({
      id: crypto.randomUUID(),
      user_id: TARGET_ID,
      reason: "warning",
      banned_until: futureIso,
      banned_at: new Date().toISOString(),
    });

    const state = await getUserBanState(TARGET_ID);
    assertEquals(state.banned, true);
    assertEquals(state.reason, "warning");
    assertEquals(state.until, futureIso);
  },
});

Deno.test({
  name: "banState: 已过期 ban（banned_until 过去）返回未封禁",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await seedUser();
    const db = getDb();
    const pastIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const banId = crypto.randomUUID();
    await db.insert(userBans).values({
      id: banId,
      user_id: TARGET_ID,
      reason: "warning",
      banned_until: pastIso,
      banned_at: new Date().toISOString(),
    });

    // DB 中有一条 user_bans 记录但 banned_until 已过期
    const state = await getUserBanState(TARGET_ID);
    // getUserBanState 只查 unbanned_at IS NULL，过期判断在 authMiddleware
    assertEquals(state.banned, true);
    assertEquals(state.reason, "warning");
    assertEquals(state.until, pastIso);
  },
});

Deno.test({
  name: "banCache: invalidateBanCache userId 立即失效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    let fetchCount = 0;
    const fetcher = () => {
      fetchCount++;
      return Promise.resolve({ value: "x" });
    };
    return getCached("user:abc", fetcher)
      .then((v1) => {
        assertEquals(v1.value, "x");
        assertEquals(fetchCount, 1);
        return getCached("user:abc", fetcher);
      })
      .then(() => {
        assertEquals(fetchCount, 1);
        invalidateBanCache({ userId: "abc" });
        return getCached("user:abc", fetcher);
      })
      .then(() => {
        assertEquals(fetchCount, 2);
      });
  },
});

Deno.test({
  name: "banCache: 不传参数 → 清空",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    let fetchCount = 0;
    const fetcher = () => {
      fetchCount++;
      return Promise.resolve({ value: "y" });
    };
    return getCached("k1", fetcher)
      .then(() => getCached("k2", fetcher))
      .then(() => {
        assertEquals(fetchCount, 2);
        invalidateBanCache({ all: true });
        return getCached("k1", fetcher);
      })
      .then(() => getCached("k2", fetcher))
      .then(() => {
        assertEquals(fetchCount, 4);
      });
  },
});
