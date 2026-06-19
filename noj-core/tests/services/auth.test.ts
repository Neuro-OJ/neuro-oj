import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { registerUser, loginUser, getUserProfile } from "../../src/services/auth.ts";
import { resetDbForTest, getDb } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { ConflictError, UnauthorizedError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(hasDb && hasJwt);

// 用时间戳生成唯一用户名/邮箱，避免测试间冲突
const ts = Date.now();
const TEST_USER = {
  username: `test-svc-${ts}`,
  email: `test-svc-${ts}@example.com`,
  password: "test-password-123",
};

/**
 * 清理测试用户。
 */
async function cleanupUser(username: string) {
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.username, username));
  } catch {
    // 清理失败不影响测试结果
  }
}

Deno.test({
  name: "auth service: registerUser 创建用户并返回 UserResponse",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    const user = await registerUser(TEST_USER);

    assertEquals(user.username, TEST_USER.username);
    assertEquals(user.email, TEST_USER.email);
    assertEquals(user.role, "user");
    assertEquals(typeof user.id, "string");
    assertEquals(typeof user.created_at, "string");
    // 验证不含 password_hash
    assertEquals("password_hash" in user, false);
  },
});

Deno.test({
  name: "auth service: 重复用户名注册抛出 ConflictError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    // 已存在 TEST_USER（上一步创建的），尝试重复注册
    await assertRejects(
      () =>
        registerUser({
          username: TEST_USER.username,
          email: `diff-${ts}@example.com`,
          password: "another-pass",
        }),
      ConflictError,
      "用户名已存在",
    );
  },
});

Deno.test({
  name: "auth service: 重复邮箱注册抛出 ConflictError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    await assertRejects(
      () =>
        registerUser({
          username: `diff-user-${ts}`,
          email: TEST_USER.email,
          password: "another-pass",
        }),
      ConflictError,
      "邮箱已被注册",
    );
  },
});

Deno.test({
  name: "auth service: loginUser 用用户名登录成功返回 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    const result = await loginUser({
      login: TEST_USER.username,
      password: TEST_USER.password,
    });

    assertEquals(result.user.username, TEST_USER.username);
    assertEquals(result.user.email, TEST_USER.email);
    assertEquals(typeof result.token, "string");
    // JWT 格式验证
    assertEquals(result.token.split(".").length, 3);
  },
});

Deno.test({
  name: "auth service: loginUser 用邮箱登录成功返回 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    const result = await loginUser({
      login: TEST_USER.email,
      password: TEST_USER.password,
    });

    assertEquals(result.user.email, TEST_USER.email);
    assertEquals(typeof result.token, "string");
  },
});

Deno.test({
  name: "auth service: 错误密码抛出 UnauthorizedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    await assertRejects(
      () =>
        loginUser({
          login: TEST_USER.username,
          password: "wrong-password",
        }),
      UnauthorizedError,
      "用户名或密码错误",
    );
  },
});

Deno.test({
  name: "auth service: 不存在的用户抛出 UnauthorizedError（统一消息防枚举）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    await assertRejects(
      () =>
        loginUser({
          login: "nonexistent-user-99999",
          password: "any-password",
        }),
      UnauthorizedError,
      "用户名或密码错误",
    );
  },
});

Deno.test({
  name: "auth service: getUserProfile 返回用户信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    // 先注册以获取 ID
    const registered = await registerUser({
      username: `test-profile-${ts}`,
      email: `test-profile-${ts}@example.com`,
      password: "password-123",
    });

    const profile = await getUserProfile(registered.id);
    assertEquals(profile.id, registered.id);
    assertEquals(profile.username, registered.username);
    assertEquals(profile.email, registered.email);
  },
});

Deno.test({
  name: "auth service: 不存在的用户 ID 抛出 UnauthorizedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetDbForTest();
    await assertRejects(
      () => getUserProfile("00000000-0000-0000-0000-000000000000"),
      UnauthorizedError,
      "用户不存在",
    );
  },
});

// 全部测试完成后清理
Deno.test({
  name: "auth service: cleanup test users",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanupUser(TEST_USER.username);
    await cleanupUser(`diff-user-${ts}`);
    await cleanupUser(`test-profile-${ts}`);
  },
});
