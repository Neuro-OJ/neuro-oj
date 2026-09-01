import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { TOTP } from "otpauth";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { tfaRecoveryCodes, users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { UnauthorizedError } from "../../src/lib/errors.ts";
import {
  confirmTfa,
  disableTfa,
  getTfaStatus,
  regenerateRecoveryCodes,
  setupTfa,
  verifyTfaCodeForUser,
} from "../../src/domains/identity/index.ts";

Deno.env.set("TFA_ENCRYPTION_KEY", "test-tfa-encryption-key-with-32-chars-min");

const skip = false;
const ts = Date.now();

async function seedUser() {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `tfa-user-${ts}-${id.slice(0, 6)}`,
    email: `tfa-${ts}-${id.slice(0, 6)}@example.com`,
    password_hash: await hashPassword("TestPwd-2024-Xy9"),
    created_at: now,
    updated_at: now,
  });
  return id;
}

function currentCode(secret: string): string {
  const totp = new TOTP({ secret, issuer: "NeuroOJ" });
  return totp.generate();
}

Deno.test({
  name: "tfa service: setupTfa 生成 secret 并加密存储，状态仍为未启用",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const result = await setupTfa(userId, "tfa-user");
    assertEquals(result.secret.length > 0, true);
    assertEquals(result.otpauthUrl.includes("otpauth://"), true);
    assertEquals(await getTfaStatus(userId), false);
    const rows = await getDb().select().from(users).where(eq(users.id, userId));
    assertEquals(rows[0].tfa_secret_encrypted !== null, true);
    assertEquals(rows[0].tfa_secret_encrypted!.includes(result.secret), false);
  },
});

Deno.test({
  name: "tfa service: confirmTfa 正确验证码启用并返回 10 个恢复码",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "tfa-user");
    const codes = await confirmTfa(userId, currentCode(secret));
    assertEquals(codes.length, 10);
    assertEquals(await getTfaStatus(userId), true);
  },
});

Deno.test({
  name: "tfa service: confirmTfa 错误验证码抛出 UnauthorizedError 且不启用",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    await setupTfa(userId, "tfa-user");
    await assertRejects(
      () => confirmTfa(userId, "000000"),
      UnauthorizedError,
    );
    assertEquals(await getTfaStatus(userId), false);
  },
});

Deno.test({
  name: "tfa service: disableTfa 使用 TOTP 禁用并清除 secret 和恢复码",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "tfa-user");
    const codes = await confirmTfa(userId, currentCode(secret));
    await disableTfa(userId, currentCode(secret));
    assertEquals(await getTfaStatus(userId), false);
    const userRows = await getDb().select().from(users).where(
      eq(users.id, userId),
    );
    assertEquals(userRows[0].tfa_secret_encrypted, null);
    const recoveryRows = await getDb().select().from(tfaRecoveryCodes).where(
      eq(tfaRecoveryCodes.user_id, userId),
    );
    assertEquals(recoveryRows.length, 0);
    // 原恢复码应已随禁用删除
    assertEquals(codes.length, 10);
  },
});

Deno.test({
  name: "tfa service: disableTfa 使用恢复码禁用并消费该恢复码",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "tfa-user");
    const codes = await confirmTfa(userId, currentCode(secret));
    await disableTfa(userId, codes[0]);
    assertEquals(await getTfaStatus(userId), false);
  },
});

Deno.test({
  name: "tfa service: regenerateRecoveryCodes 作废旧码并返回新码",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "tfa-user");
    const oldCodes = await confirmTfa(userId, currentCode(secret));
    const newCodes = await regenerateRecoveryCodes(
      userId,
      currentCode(secret),
    );
    assertEquals(newCodes.length, 10);
    // 旧码不再可用于登录
    assertEquals(await verifyTfaCodeForUser(userId, oldCodes[0]), false);
    assertEquals(await verifyTfaCodeForUser(userId, newCodes[0]), true);
  },
});

Deno.test({
  name: "tfa service: verifyTfaCodeForUser 恢复码一次性消费",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();
    const { secret } = await setupTfa(userId, "tfa-user");
    const codes = await confirmTfa(userId, currentCode(secret));
    assertEquals(await verifyTfaCodeForUser(userId, codes[0]), true);
    assertEquals(await verifyTfaCodeForUser(userId, codes[0]), false);
  },
});
