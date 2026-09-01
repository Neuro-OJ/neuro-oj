import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  requestReset,
  resetPassword,
} from "../../src/domains/identity/index.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { passwordResetTokens, users } from "../../src/db/schema.ts";
import {
  generateResetToken,
  hashResetToken,
} from "../../src/lib/resetToken.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { BadRequestError } from "../../src/lib/errors.ts";
import {
  type LogRecord,
  resetLogSink,
  setLogSink,
} from "../../src/lib/logging.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

const ts = Date.now();
const TEST_USER = {
  username: `test-pwreset-${ts}`,
  email: `test-pwreset-${ts}@example.com`,
  password: "OrigPass-2024-Ab1",
  newPassword: "Aa123456",
};
const APP_BASE_URL = "http://localhost:3000";

function preserveEnv(...keys: string[]): () => void {
  const previous = new Map(keys.map((key) => [key, Deno.env.get(key)]));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
}

function getMockEmailLink(records: LogRecord[]): string {
  const record = records.find((item) => item.msg === "密码重置邮件（mock）");
  assertExists(record);
  return String(record.fields.link);
}

async function cleanupUser(username: string) {
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.username, username));
  } catch {
    // ignore
  }
}

async function seedUser() {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: TEST_USER.username,
    email: TEST_USER.email,
    password_hash: await hashPassword(TEST_USER.password),
    created_at: now,
    updated_at: now,
  });
  return id;
}

// ── requestReset 测试 ──

Deno.test({
  name: "passwordReset: requestReset 已注册邮箱插入 token 行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedUser();

    await requestReset(TEST_USER.email, APP_BASE_URL);

    const db = getDb();
    const rows = await db
      .select()
      .from(passwordResetTokens);
    const ourRows = rows.filter((r) =>
      r.user_id &&
      r.user_id.length > 0
    );
    // 至少应有一条 token 记录
    assertEquals(ourRows.length > 0, true);

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: requestReset 未注册邮箱不创建 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 不 seedUser

    const before = await getDb()
      .select()
      .from(passwordResetTokens);
    const beforeCount = before.length;

    await requestReset("nobody-xxx@example.com", APP_BASE_URL);

    const after = await getDb()
      .select()
      .from(passwordResetTokens);
    assertEquals(after.length, beforeCount);
  },
});

Deno.test({
  name: "passwordReset: APP_URL 优先于请求头回退并去除尾斜杠",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreEnv = preserveEnv("APP_URL", "NOJ_ENV");
    const records: LogRecord[] = [];
    setLogSink((record) => records.push(record));
    Deno.env.set("NOJ_ENV", "development");
    Deno.env.set("APP_URL", "https://trusted.example///");

    try {
      Deno.env.set("NOJ_ENV", "test");
      await resetDbForTest();
      await seedUser();
      Deno.env.set("NOJ_ENV", "development");

      // 第二个参数模拟由恶意 Host/X-Forwarded-Proto 产生的请求头回退值。
      await requestReset(TEST_USER.email, "https://evil.example");

      const link = getMockEmailLink(records);
      assertEquals(
        link.startsWith("https://trusted.example/reset-password?token="),
        true,
      );
      assertEquals(link.includes("evil.example"), false);
    } finally {
      await cleanupUser(TEST_USER.username);
      resetLogSink();
      restoreEnv();
    }
  },
});

Deno.test({
  name: "passwordReset: 非生产环境缺少 APP_URL 时使用请求回退值",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreEnv = preserveEnv("APP_URL", "NOJ_ENV");
    const records: LogRecord[] = [];
    setLogSink((record) => records.push(record));
    Deno.env.set("NOJ_ENV", "development");
    Deno.env.delete("APP_URL");

    try {
      Deno.env.set("NOJ_ENV", "test");
      await resetDbForTest();
      await seedUser();
      Deno.env.set("NOJ_ENV", "development");

      await requestReset(TEST_USER.email, "http://localhost:3000/");

      const link = getMockEmailLink(records);
      assertEquals(
        link.startsWith("http://localhost:3000/reset-password?token="),
        true,
      );
    } finally {
      await cleanupUser(TEST_USER.username);
      resetLogSink();
      restoreEnv();
    }
  },
});

Deno.test({
  name: "passwordReset: 生产环境缺少 APP_URL 时不创建 token 或发送邮件",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreEnv = preserveEnv("APP_URL", "NOJ_ENV");
    const records: LogRecord[] = [];
    setLogSink((record) => records.push(record));
    Deno.env.set("NOJ_ENV", "production");
    Deno.env.delete("APP_URL");

    try {
      Deno.env.set("NOJ_ENV", "test");
      await resetDbForTest();
      await seedUser();
      Deno.env.set("NOJ_ENV", "production");

      await requestReset(TEST_USER.email, "https://evil.example");

      const rows = await getDb()
        .select()
        .from(passwordResetTokens);
      assertEquals(rows.length, 0);
      assertEquals(
        records.some((record) =>
          record.level === "error" && record.msg.includes("APP_URL")
        ),
        true,
      );
      assertEquals(
        records.some((record) => record.msg === "密码重置邮件（mock）"),
        false,
      );
    } finally {
      await cleanupUser(TEST_USER.username);
      resetLogSink();
      restoreEnv();
    }
  },
});

// ── resetPassword 测试 ──

Deno.test({
  name: "passwordReset: resetPassword 合法 token 改密成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();

    // 直接插入 token
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const nowIso = now.toISOString();
    await getDb().insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      used_at: null,
      created_at: nowIso,
    });

    await resetPassword(token, TEST_USER.newPassword);

    // 验证密码已更新 + token 已消耗
    const db = getDb();
    const tokenRows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.user_id, userId));
    assertEquals(tokenRows[0].used_at !== null, true);

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    assertEquals(userRows[0].password_hash !== TEST_USER.password, true);

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: resetPassword 重复提交 token 第二次 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();

    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = new Date();
    await getDb().insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      used_at: null,
      created_at: now.toISOString(),
    });

    await resetPassword(token, TEST_USER.newPassword);
    await assertRejects(
      () => resetPassword(token, TEST_USER.newPassword),
      BadRequestError,
      "重置令牌无效或已过期",
    );

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: resetPassword 过期 token 返 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();

    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = new Date();
    // 过期：now - 1min
    await getDb().insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() - 60_000).toISOString(),
      used_at: null,
      created_at: new Date(now.getTime() - 16 * 60_000).toISOString(),
    });

    await assertRejects(
      () => resetPassword(token, TEST_USER.newPassword),
      BadRequestError,
      "重置令牌无效或已过期",
    );

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: resetPassword 弱密码 400 且不消耗 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();

    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = new Date();
    await getDb().insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      used_at: null,
      created_at: now.toISOString(),
    });

    await assertRejects(
      () => resetPassword(token, "short"),
      BadRequestError,
    );

    // 验证 token 未被消耗
    const tokenRows = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.user_id, userId));
    assertEquals(tokenRows[0].used_at, null);

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: resetPassword 密码等于用户名 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await seedUser();

    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = new Date();
    await getDb().insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      used_at: null,
      created_at: now.toISOString(),
    });

    await assertRejects(
      () => resetPassword(token, TEST_USER.username.toUpperCase() + "123"),
      BadRequestError,
    );

    await cleanupUser(TEST_USER.username);
  },
});

Deno.test({
  name: "passwordReset: resetPassword 不存在的 token 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();

    const fakeToken = generateResetToken();

    await assertRejects(
      () => resetPassword(fakeToken, TEST_USER.newPassword),
      BadRequestError,
      "重置令牌无效或已过期",
    );
  },
});
