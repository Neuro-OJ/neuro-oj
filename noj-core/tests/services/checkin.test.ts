import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/connection.ts";
import { checkIns, users } from "../../src/db/schema.ts";
import { checkIn, getTodayCheckIn } from "../../src/services/checkin.ts";
import { ConflictError } from "../../src/lib/errors.ts";
import { hashPassword } from "../../src/lib/password.ts";

const hasEnv = !!Deno.env.get("DATABASE_URL") &&
  !!Deno.env.get("JWT_SECRET");

/**
 * 创建独立测试用户，返回 user_id。
 * 每个测试用 Date.now() + 随机 UUID 保证唯一。
 */
async function createTestUser(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await db.insert(users).values({
    id,
    username: `checkin_test_${unique}`,
    email: `checkin_test_${unique}@test.com`,
    password_hash: await hashPassword("TestCheckinPass1"),
    role: "user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

/**
 * 清理测试用户 + 签到记录。
 */
async function cleanup(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(checkIns).where(eq(checkIns.user_id, userId));
  await db.delete(users).where(eq(users.id, userId));
}

Deno.test({
  name: "checkin: 首次签到返回 streak=1",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const result = await checkIn(userId);
      assertEquals(result.checked_in, true);
      assertEquals(result.streak, 1);
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: 同日重复签到抛 ConflictError（评审 H2 + M3）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      await checkIn(userId);
      // 第二次签到应抛 ConflictError（409）而非 BadRequestError（400）
      let caught: unknown = null;
      try {
        await checkIn(userId);
      } catch (e) {
        caught = e;
      }
      if (!(caught instanceof ConflictError)) {
        throw new Error("期望 ConflictError, 实际 " + caught);
      }
      assertEquals((caught as ConflictError).statusCode, 409);
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: 并发签到两个都返回正确（评审 H2 关键）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      // 并发执行两个签到：只有一个成功，另一个抛 ConflictError
      const results = await Promise.allSettled([
        checkIn(userId),
        checkIn(userId),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      if (fulfilled.length !== 1 || rejected.length !== 1) {
        throw new Error(
          "期望 1 成功 + 1 失败, 实际 " +
            `${fulfilled.length} 成功 + ${rejected.length} 失败`,
        );
      }
      // 失败的那个应是 ConflictError
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      if (!(reason instanceof ConflictError)) {
        throw new Error("期望失败原因是 ConflictError, 实际 " + reason);
      }
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: 昨日签到后今日签到 streak 累加",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      // 直接插入昨日签到记录（streak=3）模拟连续 3 天签到
      const db = getDb();
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      await db.insert(checkIns).values({
        id: crypto.randomUUID(),
        user_id: userId,
        checkin_date: yesterdayStr,
        streak: 3,
        created_at: yesterday.toISOString(),
      });

      const result = await checkIn(userId);
      assertEquals(result.streak, 4); // 昨日 streak=3, 今日=4
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: 断签后签到 streak 重置为 1",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      // 插入 3 天前的签到记录（streak=5），模拟断签
      const db = getDb();
      const threeDaysAgo = new Date();
      threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
      const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
      await db.insert(checkIns).values({
        id: crypto.randomUUID(),
        user_id: userId,
        checkin_date: threeDaysAgoStr,
        streak: 5,
        created_at: threeDaysAgo.toISOString(),
      });

      const result = await checkIn(userId);
      assertEquals(result.streak, 1); // 断签后重置
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: getTodayCheckIn 未签到返回 checked_in=false",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const result = await getTodayCheckIn(userId);
      assertEquals(result.checked_in, false);
      assertEquals(result.streak, 0);
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin: getTodayCheckIn 已签到返回当前 streak",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      await checkIn(userId);
      const result = await getTodayCheckIn(userId);
      assertEquals(result.checked_in, true);
      assertEquals(result.streak, 1);
    } finally {
      await cleanup(userId);
    }
  },
});
