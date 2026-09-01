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
} from "../../src/domains/identity/index.ts";
import {
  disableTestTransactionForFile,
  getDb,
  resetDbForTest,
} from "../../src/db/connection.ts";

// 本文件用例依赖“改密结果在后续用例中持续生效”，关闭事务回滚隔离
disableTestTransactionForFile();

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
// 模块级 setup：事务外注册共享测试用户
await resetDbForTest();
const registeredUser = await registerUser(TEST_USER);
const testUserId = registeredUser.id;
assertEquals(registeredUser.must_change_password, false);

Deno.test({
  name: "auth service changePassword: 正常改密返回 must_change_password=false",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await changePassword(
      testUserId,
      TEST_USER.password,
      "Aa123456",
    );
    assertEquals(result.must_change_password, false);
    assertEquals(result.id, testUserId);
    // 改密后能用新密码登录
    const loginResult = await loginUser({
      login: TEST_USER.email,
      password: "Aa123456",
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
    // 上一步已将测试用户密码改为恰好 8 位的 "Aa123456"
    await assertRejects(
      () => changePassword(testUserId, "Aa123456", "123"),
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
          "Aa123456",
          "Aa123456",
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
