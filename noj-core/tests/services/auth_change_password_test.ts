/**
 * changePassword 服务层测试（issue #75）。
 *
 * 覆盖：正常改密、旧密码错误、弱密码拒绝、新旧密码相同、用户不存在。
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  changePassword,
  loginUser,
  registerUser,
} from "../../src/services/auth.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { BadRequestError, UnauthorizedError } from "../../src/lib/errors.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(hasDb && hasJwt);

const ts = Date.now();
const TEST_USER = {
  username: `cp-svc-${ts}`,
  email: `cp-svc-${ts}@example.com`,
  password: "OrigPwd-2024-Xy9",
};
let testUserId = "";

Deno.test({
  name: "auth service changePassword: 注册测试用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const user = await registerUser(TEST_USER);
    testUserId = user.id;
    assertEquals(user.must_change_password, false);
  },
});

Deno.test({
  name: "auth service changePassword: 正常改密返回 must_change_password=false",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await changePassword(
      testUserId,
      TEST_USER.password,
      "NewStr0ng!Pass-2024",
    );
    assertEquals(result.must_change_password, false);
    assertEquals(result.id, testUserId);
    // 改密后能用新密码登录
    const loginResult = await loginUser({
      login: TEST_USER.email,
      password: "NewStr0ng!Pass-2024",
    });
    assertEquals(loginResult.user.id, testUserId);
  },
});

Deno.test({
  name: "auth service changePassword: 旧密码错误抛 UnauthorizedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => changePassword(testUserId, "WrongOldPass-123", "NewPass-2024-Xx1"),
      UnauthorizedError,
      "旧密码错误",
    );
  },
});

Deno.test({
  name: "auth service changePassword: 弱密码抛 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 注册一个新用户，密码为 "NewStr0ng!Pass-2024"（上一步已改为此密码）
    await assertRejects(
      () => changePassword(testUserId, "NewStr0ng!Pass-2024", "123"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "auth service changePassword: 新密码与旧密码相同抛 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        changePassword(
          testUserId,
          "NewStr0ng!Pass-2024",
          "NewStr0ng!Pass-2024",
        ),
      BadRequestError,
      "新密码不能与旧密码相同",
    );
  },
});

Deno.test({
  name: "auth service changePassword: 不存在的用户抛 UnauthorizedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        changePassword(
          "00000000-0000-0000-0000-000000000000",
          "AnyPass-2024-Ab1",
          "NewPass-2024-Xx1",
        ),
      UnauthorizedError,
      "用户不存在",
    );
  },
});

// 清理
Deno.test({
  name: "auth service changePassword: 清理测试用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(users).where(eq(users.username, TEST_USER.username));
    } catch {
      // 忽略清理错误
    }
  },
});
