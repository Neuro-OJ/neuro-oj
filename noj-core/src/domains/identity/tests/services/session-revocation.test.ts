import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { PGlite } from "@electric-sql/pglite";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { passwordResetTokens, users } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../middleware/auth.ts";
import authRouter from "../../routes/auth.ts";
import { changePassword, loginUser, setPassword } from "../../index.ts";
import { resolveOAuthIdentity } from "../../services/oauth.ts";
import { resetPassword } from "../../services/passwordReset.ts";
import { hashPassword } from "../../services/security/password.ts";
import { hashResetToken } from "../../services/security/resetToken.ts";
import { signToken, verifyToken } from "../../services/security/jwt.ts";

const oldPassword = "Original-2026-Ab1";
const newPassword = "Replacement-2026-Cd2";

function sessionTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `session-revocation: ${name}`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const keys = [
        "JWT_SECRET",
        "NOJ_ENV",
        "RATE_LIMIT_ENABLED",
        "NOJ_BYPASS_JWT_REVOKE",
      ];
      const previous = keys.map((key) => Deno.env.get(key));
      Deno.env.set(
        "JWT_SECRET",
        "session-version-test-key-at-least-32-characters",
      );
      Deno.env.set("NOJ_ENV", "test");
      Deno.env.set("RATE_LIMIT_ENABLED", "false");
      Deno.env.delete("NOJ_BYPASS_JWT_REVOKE");
      resetRedisForTest();
      const redis = getRedis();
      const revoked = new Set<string>();
      // 保留真实 JWT/数据库/中间件路径，仅用内存替代 Redis 撤销存储。
      redis.exists = (key) => Promise.resolve(revoked.has(key) ? 1 : 0);
      redis.set = (key) => {
        revoked.add(key);
        return Promise.resolve("OK");
      };
      try {
        await resetDbForTest();
        await fn();
      } finally {
        resetRedisForTest();
        keys.forEach((key, i) => {
          if (previous[i] === undefined) Deno.env.delete(key);
          else Deno.env.set(key, previous[i]!);
        });
      }
    },
  });
}

function app() {
  const router = new Hono<{ Variables: { userId?: string } }>();
  router.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message },
        error.statusCode as 400 | 401 | 403 | 500,
      );
    }
    throw error;
  });
  router.get(
    "/protected",
    authMiddleware,
    (c) => c.json({ userId: c.get("userId") }),
  );
  router.get(
    "/optional",
    optionalAuthMiddleware,
    (c) => c.json({ userId: c.get("userId") ?? null }),
  );
  router.route("/api/v1/auth", authRouter);
  return router;
}

async function seedUser() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const [user] = await getDb().insert(users).values({
    id,
    username: `session_${id.slice(0, 8)}`,
    email: `${id}@example.test`,
    password_hash: await hashPassword(oldPassword),
    created_at: now,
    updated_at: now,
  }).returning();
  return user;
}

async function seedResetToken(userId: string, expired = false) {
  const token = crypto.randomUUID();
  await getDb().insert(passwordResetTokens).values({
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: await hashResetToken(token),
    expires_at: new Date(Date.now() + (expired ? -60000 : 900000))
      .toISOString(),
    created_at: new Date().toISOString(),
  });
  return token;
}

function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

sessionTest(
  "重置撤销全部设备与历史令牌，可选认证降级匿名，新登录有效",
  async () => {
    const user = await seedUser();
    const other = await seedUser();
    const first = await loginUser({
      login: user.username,
      password: oldPassword,
    });
    const second = await loginUser({
      login: user.username,
      password: oldPassword,
    });
    const legacy = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("noj-core").setAudience(
        "noj-ui",
      )
      .setSubject(user.id).setJti(crypto.randomUUID()).setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(Deno.env.get("JWT_SECRET")));
    const otherToken = await signToken({ sub: other.id, role: "user" });
    const router = app();
    for (const token of [first.token, second.token, legacy]) {
      assertEquals(
        (await router.request("/protected", { headers: headers(token) }))
          .status,
        200,
      );
    }
    await resetPassword(await seedResetToken(user.id), newPassword);
    for (const token of [first.token, second.token, legacy]) {
      assertEquals(
        (await router.request("/protected", { headers: headers(token) }))
          .status,
        401,
      );
      const optional = await router.request("/optional", {
        headers: headers(token),
      });
      assertEquals(await optional.json(), { userId: null });
    }
    assertEquals(
      (await router.request("/protected", { headers: headers(otherToken) }))
        .status,
      200,
    );
    const fresh = await loginUser({
      login: user.username,
      password: newPassword,
    });
    assertEquals((await verifyToken(fresh.token)).session_version, 1);
    assertEquals(
      (await router.request("/protected", { headers: headers(fresh.token) }))
        .status,
      200,
    );
  },
);

sessionTest(
  "无效重置不撤销会话，成功重置清除强制改密，重复消费不影响新会话",
  async () => {
    const user = await seedUser();
    const token = await signToken({ sub: user.id, role: "user" });
    const validReset = await seedResetToken(user.id);
    await assertRejects(() =>
      resetPassword("nonexistent-reset-token", newPassword)
    );
    await assertRejects(() => resetPassword(validReset, "weak"));
    const expired = await seedResetToken(user.id, true);
    await assertRejects(() => resetPassword(expired, newPassword));
    assertEquals(
      (await app().request("/protected", { headers: headers(token) })).status,
      200,
    );
    await getDb().update(users).set({ must_change_password: true }).where(
      eq(users.id, user.id),
    );
    await resetPassword(validReset, newPassword);
    const fresh = await loginUser({
      login: user.username,
      password: newPassword,
    });
    assertEquals(fresh.user.must_change_password, false);
    await assertRejects(() => resetPassword(validReset, "Another-2026-Ab3"));
    assertEquals(
      (await app().request("/protected", { headers: headers(fresh.token) }))
        .status,
      200,
    );
  },
);

sessionTest("改密路由撤销其他设备并返回可用的新会话", async () => {
  const user = await seedUser();
  const first = await loginUser({
    login: user.username,
    password: oldPassword,
  });
  const second = await loginUser({
    login: user.username,
    password: oldPassword,
  });
  const router = app();
  const response = await router.request("/api/v1/auth/change-password", {
    method: "POST",
    headers: headers(first.token),
    body: JSON.stringify({
      old_password: oldPassword,
      new_password: newPassword,
    }),
  });
  assertEquals(response.status, 200);
  const { data } = await response.json();
  assertEquals("sessionVersion" in data.user, false);
  assertEquals(
    (await router.request("/protected", { headers: headers(first.token) }))
      .status,
    401,
  );
  assertEquals(
    (await router.request("/protected", { headers: headers(second.token) }))
      .status,
    401,
  );
  assertEquals(
    (await router.request("/protected", { headers: headers(data.token) }))
      .status,
    200,
  );
});

sessionTest(
  "OAuth 用户补设和重置密码后，新 OAuth 会话携带最新版本",
  async () => {
    const identity = {
      providerUserId: crypto.randomUUID(),
      username: "session_oauth",
      email: "session_oauth@example.test",
      emailVerified: true,
    };
    const first = await resolveOAuthIdentity("github", identity, "login");
    await setPassword(first.user.id, oldPassword);
    assertEquals(
      (await app().request("/protected", { headers: headers(first.token) }))
        .status,
      401,
    );
    await resetPassword(await seedResetToken(first.user.id), newPassword);
    const fresh = await resolveOAuthIdentity("github", identity, "login");
    assertEquals((await verifyToken(fresh.token)).session_version, 2);
    assertEquals(
      (await app().request("/protected", { headers: headers(fresh.token) }))
        .status,
      200,
    );
  },
);

sessionTest("并发改密只有一个旧凭据更新能成功", async () => {
  const user = await seedUser();
  const results = await Promise.allSettled([
    changePassword(user.id, oldPassword, newPassword),
    changePassword(user.id, oldPassword, "Another-2026-Xy3"),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
  assertEquals(row.session_version, 1);
});

sessionTest("新增迁移保留旧用户并赋予初始会话版本", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('existing'); CREATE TABLE search_entries (id TEXT PRIMARY KEY);",
    );
    const migration = await Deno.readTextFile(
      new URL(
        "../../../../../drizzle/0082_bouncy_marvel_boy.sql",
        import.meta.url,
      ),
    );
    await db.exec(migration);
    const result = await db.query("SELECT id, session_version FROM users");
    assertEquals(result.rows, [{ id: "existing", session_version: 0 }]);
  } finally {
    await db.close();
  }
});
