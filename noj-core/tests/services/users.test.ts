import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getUserProfile, updateUserProfile } from "../../src/services/users.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { NotFoundError, ValidationError } from "../../src/lib/errors.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_USER_ID = `tst-u-${ts}`;

Deno.test({
  name: "users service: 创建测试用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: TEST_USER_ID,
      username: `tstusr-${ts}`,
      email: `tstusr-${ts}@test.noj`,
      password_hash: "hash",
      role: "user",
      bio: "",
      created_at: now,
      updated_at: now,
    });
  },
});

Deno.test({
  name: "users service: getUserProfile 返回完整用户主页数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const profile = await getUserProfile(TEST_USER_ID);
    assertEquals(profile.user.id, TEST_USER_ID);
    assertEquals(profile.user.username, `tstusr-${ts}`);
    assertEquals(typeof profile.stats.total_submissions, "number");
    assertEquals(typeof profile.stats.accepted, "number");
    assertEquals(typeof profile.stats.acceptance_rate, "number");
    assertEquals(typeof profile.stats.solved_count, "number");
    assertEquals(Array.isArray(profile.solved_problems), true);
    assertEquals(Array.isArray(profile.recent_submissions), true);
  },
});

Deno.test({
  name: "users service: getUserProfile 不存在的用户抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => getUserProfile("nonexistent-user"),
      NotFoundError,
      "用户不存在",
    );
  },
});

Deno.test({
  name: "users service: updateUserProfile 更新 bio 成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bio = "updated bio " + ts;
    const result = await updateUserProfile(TEST_USER_ID, bio);
    assertEquals(result.id, TEST_USER_ID);
    assertEquals(result.bio, bio);
  },
});

Deno.test({
  name: "users service: updateUserProfile bio 超长抛出 ValidationError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const longBio = "x".repeat(5001);
    await assertRejects(
      () => updateUserProfile(TEST_USER_ID, longBio),
      ValidationError,
    );
  },
});

Deno.test({
  name: "users service: updateUserProfile 不存在的用户抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => updateUserProfile("nonexistent-user", "bio"),
      NotFoundError,
      "用户不存在",
    );
  },
});

Deno.test({
  name: "users service: 清理测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(users).where(eq(users.id, TEST_USER_ID));
  },
});
