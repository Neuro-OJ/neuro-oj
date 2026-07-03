import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  getUserProfile,
  loginUser,
  registerUser,
} from "../../src/services/auth.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { ConflictError, UnauthorizedError } from "../../src/lib/errors.ts";

// PGlite 内存数据库始终可用
const dbAvailable = true;
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(dbAvailable && hasJwt);

const ts = Date.now();
const TEST_USER = {
  username: `test-svc-${ts}`,
  email: `test-svc-${ts}@example.com`,
  password: "TestPwd-2024-Xy9",
};

// 模块级 setup：创建跨测试共享的 TEST_USER
// 在 PGlite 模式下每次 resetDbForTest() 会 TRUNCATE，因此放在模块级执行一次
await resetDbForTest();
await registerUser(TEST_USER);

Deno.test({
  name: "auth service: registerUser 创建用户并返回 UserResponse",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 验证模块级创建的 TEST_USER 存在
    const result = await loginUser({
      login: TEST_USER.username,
      password: TEST_USER.password,
    });
    assertEquals(result.user.username, TEST_USER.username);
    assertEquals(result.user.email, TEST_USER.email);
    assertEquals(result.user.role, "user");
    assertEquals(typeof result.user.id, "string");
    assertEquals("password_hash" in result.user, false);
  },
});

Deno.test({
  name: "auth service: 重复用户名注册抛出 ConflictError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // TEST_USER 来自模块级 setup
    await assertRejects(
      () =>
        registerUser({
          username: TEST_USER.username,
          email: `diff-${ts}@example.com`,
          password: "AnothPass-2024-Ab1",
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
    await assertRejects(
      () =>
        registerUser({
          username: `diff-user-${ts}`,
          email: TEST_USER.email,
          password: "AnothPass-2024-Ab1",
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
    const result = await loginUser({
      login: TEST_USER.username,
      password: TEST_USER.password,
    });

    assertEquals(result.user.username, TEST_USER.username);
    assertEquals(result.user.email, TEST_USER.email);
    assertEquals(typeof result.token, "string");
    assertEquals(result.token.split(".").length, 3);
  },
});

Deno.test({
  name: "auth service: loginUser 用邮箱登录成功返回 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
    await assertRejects(
      () =>
        loginUser({
          login: TEST_USER.username,
          password: "WrongPwd-2024-Cd2",
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
    await assertRejects(
      () =>
        loginUser({
          login: "nonexistent-user-99999",
          password: "AnyPwd-2024-Ef3",
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
    await resetDbForTest();
    const profileUser = {
      username: `test-profile-${Date.now()}`,
      email: `test-profile-${Date.now()}@example.com`,
      password: "ProfilePwd-2024-Xx9",
    };
    const registered = await registerUser(profileUser);

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
    await resetDbForTest();
    await assertRejects(
      () => getUserProfile("00000000-0000-0000-0000-000000000000"),
      UnauthorizedError,
      "用户不存在",
    );
  },
});
