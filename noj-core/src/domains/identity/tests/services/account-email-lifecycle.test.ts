import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { SignJWT } from "jose";
import {
  adminDeleteAccount,
  loginUser,
  sendEmailVerification,
  verifyEmailToken,
} from "../../index.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { hashPassword } from "../../services/security/password.ts";
import { hashResetToken } from "../../services/security/resetToken.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  auditLogs,
  communityPosts,
  users,
} from "../../../../shared/db/schema.ts";
import { AppError, ForbiddenError } from "../../../../shared/base/errors.ts";
import { resetEmailProvider } from "../../../system/services/email.ts";
import { takeMockEmailsForTest } from "../../../system/services/email-providers/mock.ts";
import { runWithContext } from "../../../system/index.ts";
import { getPost } from "../../../community/index.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";

async function seedUser(verified = false) {
  const id = crypto.randomUUID();
  const suffix = id.slice(0, 8);
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `lifecycle_${suffix}`,
    email: `lifecycle_${suffix}@example.com`,
    email_verified: verified,
    password_hash: await hashPassword("Lifecycle-2026-Ab1"),
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test("邮箱验证：注册路由发送 mock 邮件并由验证路由完成闭环", async () => {
  await resetDbForTest();
  Deno.env.set("NOJ_ENV", "test");
  resetEmailProvider();
  takeMockEmailsForTest();
  const { createApp } = await import("../../../../app.ts");
  const app = createApp();
  const suffix = crypto.randomUUID().slice(0, 8);
  const registered = await jsonRequest(app, "/api/v1/auth/register", {
    method: "POST",
    body: {
      username: `route_${suffix}`,
      email: `route_${suffix}@example.com`,
      password: "RouteVerify-2026-Ab1",
    },
  });
  assertEquals(registered.status, 201);
  const [mail] = takeMockEmailsForTest();
  assertExists(mail);
  const match = mail.html.match(/token=([^"&<]+)/);
  assertExists(match);
  const verified = await jsonRequest(app, "/api/v1/auth/email/verify", {
    method: "POST",
    body: { token: decodeURIComponent(match[1]) },
  });
  assertEquals(verified.status, 200);
});

Deno.test("邮箱验证：mock 邮件令牌可验证且只能使用一次", async () => {
  await resetDbForTest();
  Deno.env.set("NOJ_ENV", "test");
  resetEmailProvider();
  takeMockEmailsForTest();
  const userId = await seedUser(false);
  assertEquals(
    await sendEmailVerification(userId, "http://localhost:3000"),
    true,
  );
  const [mail] = takeMockEmailsForTest();
  assertExists(mail);
  const match = mail.html.match(/token=([^"&<]+)/);
  assertExists(match);
  const token = decodeURIComponent(match[1]);
  await verifyEmailToken(token);
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  assertEquals(user.email_verified, true);
  assertEquals(user.email_verify_token, null);
  await assertRejects(() => verifyEmailToken(token), AppError);
  await assertRejects(() => verifyEmailToken("wrong-token"), AppError);
});

Deno.test("邮箱验证：过期令牌被拒绝", async () => {
  await resetDbForTest();
  const userId = await seedUser(false);
  const token = "expired-email-token";
  await getDb().update(users).set({
    email_verify_token: await hashResetToken(token),
    email_verify_expires_at: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(users.id, userId));
  await assertRejects(() => verifyEmailToken(token), AppError);
});

Deno.test("邮箱验证：未验证用户写提交被拦截，验证后解锁", async () => {
  await resetDbForTest();
  Deno.env.set("JWT_SECRET", "email-test-secret-at-least-32-characters-long");
  const userId = await seedUser(false);
  const token = await new SignJWT({ role: "user", must_change_password: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("noj-core")
    .setAudience("noj-ui")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(Deno.env.get("JWT_SECRET")!));
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ code: error.code }, error.statusCode as 403)
      : c.json({ code: "INTERNAL" }, 500)
  );
  app.post("/api/v1/submissions", authMiddleware, (c) => c.json({ ok: true }));
  const request = () =>
    app.request("/api/v1/submissions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  assertEquals((await request()).status, 403);
  await getDb().update(users).set({ email_verified: true }).where(
    eq(users.id, userId),
  );
  assertEquals((await request()).status, 200);
});

Deno.test("邮箱验证：一分钟内重复发送会触发限流", async () => {
  await resetDbForTest();
  Deno.env.set("NOJ_ENV", "test");
  resetEmailProvider();
  takeMockEmailsForTest();
  const userId = await seedUser(false);
  await sendEmailVerification(userId, "http://localhost:3000");
  await assertRejects(
    () => sendEmailVerification(userId, "http://localhost:3000", true),
    AppError,
  );
});

Deno.test("账户注销：密码确认后身份匿名化且不可再次登录", async () => {
  await resetDbForTest();
  const userId = await seedUser(true);
  const postId = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(communityPosts).values({
    id: postId,
    type: "moment",
    author_id: userId,
    content: "应被保留的公开内容",
    status: "published",
    published_at: now,
    created_at: now,
    updated_at: now,
  });
  const token = await new SignJWT({ role: "user", must_change_password: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("noj-core")
    .setAudience("noj-ui")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(Deno.env.get("JWT_SECRET")!));
  const { createApp } = await import("../../../../app.ts");
  const deleted = await jsonRequest(
    createApp(),
    "/api/v1/users/me/delete-account",
    {
      method: "POST",
      token,
      body: { password: "Lifecycle-2026-Ab1" },
    },
  );
  assertEquals(deleted.status, 204);
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  assertEquals(user.username, "已注销用户");
  assertEquals(user.password_hash, null);
  assertExists(user.deleted_at);
  const post = await getPost(postId);
  assertEquals(post.author.username, "已注销用户");
  assertEquals(post.post.content, "应被保留的公开内容");
  await assertRejects(
    () => loginUser({ login: user.email, password: "Lifecycle-2026-Ab1" }),
    AppError,
  );
});

Deno.test("账户注销：root 被拒绝，管理员注销写入审计", async () => {
  await resetDbForTest();
  await assertRejects(() => adminDeleteAccount("0"), ForbiddenError);
  const userId = await seedUser(true);
  await runWithContext(
    { actorId: "0", actorIp: "127.0.0.1", actorRole: "root" },
    () => adminDeleteAccount(userId),
  );
  const rows = await getDb().select().from(auditLogs).where(
    eq(auditLogs.target_id, userId),
  );
  assertEquals(rows.some((row) => row.action === "users.delete"), true);
});
