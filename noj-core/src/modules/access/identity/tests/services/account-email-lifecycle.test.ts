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
import { assertContentWriteAccount } from "../../services/security/account-access.ts";
import { hashPassword } from "../../services/security/password.ts";
import { hashResetToken } from "../../services/security/resetToken.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  auditLogs,
  communityPosts,
  roles,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { AppError, ForbiddenError } from "../../../../../shared/base/errors.ts";
import type { AuthEnv } from "../../../../../shared/http/hono-env.ts";
import { resetEmailProvider } from "../../../../platform/system/index.ts";
import { takeMockEmailsForTest } from "../../../../platform/system/services/email-providers/mock.ts";
import { getPost } from "../../../../communication/index.ts";
import { jsonRequest } from "../../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import { userActorFromAuthenticatedId } from "../../../contracts/actor.ts";

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

async function seedAdmin(verified = true) {
  const userId = await seedUser(verified);
  const [role] = await getDb().select({ id: roles.id }).from(roles).where(
    eq(roles.name, "admin"),
  );
  await getDb().insert(userRoles).values({ user_id: userId, role_id: role.id });
  return userId;
}

Deno.test("邮箱验证：注册路由发送 mock 邮件并由验证路由完成闭环", async () => {
  await resetDbForTest();
  Deno.env.set("NOJ_ENV", "test");
  Deno.env.set("NOJ_RUN_E2E", "1");
  resetEmailProvider();
  takeMockEmailsForTest();
  try {
    const { createApp } = await import("../../../../../app.ts");
    const app = createApp();
    const suffix = crypto.randomUUID().slice(0, 8);
    const registered = await jsonRequest(app, "/api/v1/auth/register", {
      method: "POST",
      body: {
        username: `route_${suffix}`,
        email: `route_${suffix}@example.com`,
        password: "RouteVerify-2026-Ab1",
        accepted_legal: true,
      },
    });
    assertEquals(registered.status, 201);
    const body = await registered.json();
    const token = body.data?.email_verification_token;
    assertEquals(typeof token, "string");
    const [mail] = takeMockEmailsForTest();
    assertExists(mail);
    const verified = await jsonRequest(app, "/api/v1/auth/email/verify", {
      method: "POST",
      body: { token },
    });
    assertEquals(verified.status, 200);
  } finally {
    Deno.env.delete("NOJ_RUN_E2E");
  }
});

Deno.test("邮箱验证：mock 邮件令牌可验证且只能使用一次", async () => {
  await resetDbForTest();
  Deno.env.set("NOJ_ENV", "test");
  resetEmailProvider();
  takeMockEmailsForTest();
  const userId = await seedUser(false);
  assertEquals(
    (await sendEmailVerification(userId, "http://localhost:3000")).sent,
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

// 2026-11-02 rc/v0.11 审计 F2：邮箱验证政策**不再**挂在认证中间件的 URL 前缀
// 清单上（`/api/v1/submissions` 等），而是绑定到"内容写"能力本身：
// `assertContentWriteAccount()` 由社区写闸口 `assertCommunityWritable()` 与评测
// 受理（`composeEvaluationAdmissionContext` / `composeDomainEvaluationAdmissionPlan`）
// 调用。因此这里断言两件事：中间件放行（它只负责身份与账号可用性，并继续下发
// `emailVerified` 供 UI 提示）、能力函数拒绝并给出同一错误码。
Deno.test("邮箱验证：政策绑定到内容写能力而非中间件路径清单（审计 F2）", async () => {
  await resetDbForTest();
  const userId = await seedUser(false);
  const token = await new SignJWT({ role: "user", must_change_password: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("noj-core")
    .setAudience("noj-ui")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(Deno.env.get("JWT_SECRET")!));
  const app = new Hono<AuthEnv>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ code: error.code }, error.statusCode as 403)
      : c.json({ code: "INTERNAL" }, 500)
  );
  app.use("*", authMiddleware);
  app.post(
    "/api/v1/submissions",
    (c) => c.json({ ok: true, emailVerified: c.get("emailVerified") }),
  );
  const request = () =>
    app.request("/api/v1/submissions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  // 中间件不再按路径拒绝：认证成功即放行，并把账号事实交给下游决定。
  const unverified = await request();
  assertEquals(unverified.status, 200);
  assertEquals((await unverified.json()).emailVerified, false);

  // 未验证账号在"内容写"能力闸口被拒绝，错误码与旧行为一致。
  const blocked = await assertRejects(
    () => assertContentWriteAccount(userId),
    AppError,
  );
  assertEquals(blocked.code, "EMAIL_VERIFICATION_REQUIRED");
  assertEquals(blocked.statusCode, 403);

  await getDb().update(users).set({ email_verified: true }).where(
    eq(users.id, userId),
  );
  // 验证后能力解锁；中间件下发的账号事实同步为 true（UI 据此隐藏提示横幅）。
  await assertContentWriteAccount(userId);
  assertEquals((await (await request()).json()).emailVerified, true);
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
    domain_id: DEFAULT_DOMAIN_ID,
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
  const { createApp } = await import("../../../../../app.ts");
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
  await assertRejects(
    () => adminDeleteAccount("0", userActorFromAuthenticatedId("operator")),
    ForbiddenError,
  );
  const actorId = await seedAdmin();
  const userId = await seedUser(true);
  await adminDeleteAccount(userId, userActorFromAuthenticatedId(actorId));
  const rows = await getDb().select().from(auditLogs).where(
    eq(auditLogs.target_id, userId),
  );
  assertEquals(rows.some((row) => row.action === "users.delete"), true);
});
