import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { TOTP } from "otpauth";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { BadRequestError, UnauthorizedError } from "../../src/lib/errors.ts";
import { loginUser } from "../../src/services/auth.ts";
import {
  confirmTfa,
  setupTfa,
  verifyTfaCodeForUser,
} from "../../src/services/tfa.ts";

Deno.env.set("TFA_ENCRYPTION_KEY", "test-tfa-encryption-key-with-32-chars-min");
Deno.env.set("JWT_SECRET", "test-jwt-secret-with-at-least-32-characters");

const hasDb = true;
const skip = !hasDb;
const ts = Date.now();

async function seedUser() {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `auth-tfa-${ts}-${id.slice(0, 6)}`,
    email: `auth-tfa-${ts}-${id.slice(0, 6)}@example.com`,
    password_hash: await hashPassword("TestPwd-2024-Xy9"),
    created_at: now,
    updated_at: now,
  });
  return id;
}

function currentCode(secret: string): string {
  return new TOTP({ secret, issuer: "NeuroOJ" }).generate();
}

Deno.test({
  name: "auth tfa: 已启用 TFA 用户缺少 code 抛出 TFA_REQUIRED",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "auth-tfa");
    await confirmTfa(userId, currentCode(secret));
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    try {
      await loginUser({
        login: userRows[0].username,
        password: "TestPwd-2024-Xy9",
      });
      throw new Error("应当抛出 BadRequestError");
    } catch (err) {
      const e = err as { code?: string };
      assertEquals(e instanceof BadRequestError, true);
      assertEquals(e.code, "TFA_REQUIRED");
    }
  },
});

Deno.test({
  name: "auth tfa: 已启用 TFA 用户错误验证码抛出 UnauthorizedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "auth-tfa");
    await confirmTfa(userId, currentCode(secret));
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    await assertRejects(
      () =>
        loginUser({
          login: userRows[0].username,
          password: "TestPwd-2024-Xy9",
          code: "000000",
        }),
      UnauthorizedError,
    );
  },
});

Deno.test({
  name: "auth tfa: 已启用 TFA 用户正确 TOTP 登录成功且返回 tfa_enabled",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "auth-tfa");
    await confirmTfa(userId, currentCode(secret));
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    const result = await loginUser({
      login: userRows[0].username,
      password: "TestPwd-2024-Xy9",
      code: currentCode(secret),
    });
    assertEquals(result.user.tfa_enabled, true);
    assertEquals(typeof result.token, "string");
  },
});

Deno.test({
  name: "auth tfa: 恢复码登录成功且一次性消费",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "auth-tfa");
    const codes = await confirmTfa(userId, currentCode(secret));
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    const result = await loginUser({
      login: userRows[0].username,
      password: "TestPwd-2024-Xy9",
      code: codes[0],
    });
    assertEquals(result.user.tfa_enabled, true);
    assertEquals(await verifyTfaCodeForUser(userId, codes[0]), false);
  },
});

Deno.test({
  name: "auth tfa: 未启用 TFA 用户不带 code 登录行为不变",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    const result = await loginUser({
      login: userRows[0].username,
      password: "TestPwd-2024-Xy9",
    });
    assertEquals(result.user.tfa_enabled, false);
    assertEquals(typeof result.token, "string");
  },
});
