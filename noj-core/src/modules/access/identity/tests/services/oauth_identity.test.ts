import { userActorFromAuthenticatedId } from "../../../contracts/actor.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  auditLogs,
  oauthAccounts,
  userBans,
  users,
} from "../../../../../shared/db/schema.ts";
import { ADMIN_INITIALIZATION_KEY } from "../../../../../shared/security/admin-initialization.ts";
import { systemSettings } from "../../../../../shared/db/schema.ts";
import { loginUser } from "../../index.ts";
import { setPassword } from "../../index.ts";
import {
  linkPasswordMatches,
  resolveOAuthIdentity,
  unlinkOAuthAccount,
} from "../../index.ts";
import { ForbiddenError } from "../../../../../shared/base/errors.ts";

const originalEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string) {
  if (!originalEnv.has(key)) originalEnv.set(key, Deno.env.get(key));
  Deno.env.set(key, value);
}
function restoreEnv() {
  for (const [key, value] of originalEnv) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  originalEnv.clear();
}

Deno.test({
  name: "oauth: first identity creates passwordless user and can set password",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    setEnv("JWT_SECRET", "oauth-identity-test-secret-that-is-long-enough");
    setEnv("NOJ_ENV", "test");
    try {
      await resetDbForTest();
      const result = await resolveOAuthIdentity(
        "github",
        {
          providerUserId: "github-identity-1",
          username: "oauth_test_user",
          email: "oauth-test@example.com",
          emailVerified: true,
        },
        "login",
        undefined,
        true,
      );

      assertEquals(result.user.has_local_password, false);
      assertEquals(result.user.is_admin, false);
      const closed = await getDb().select().from(systemSettings).where(
        eq(systemSettings.key, ADMIN_INITIALIZATION_KEY),
      );
      assertEquals(closed.length, 1);
      const [row] = await getDb().select().from(users).where(
        eq(users.id, result.user.id),
      );
      assertEquals(row.password_hash, null);
      const links = await getDb().select().from(oauthAccounts).where(
        eq(oauthAccounts.user_id, result.user.id),
      );
      assertEquals(links.length, 1);

      await assertRejects(
        () => loginUser({ login: result.user.username, password: "anything" }),
        Error,
        "用户名或密码错误",
      );
      const updated = await setPassword(
        result.user.id,
        "StrongPass1",
        "127.0.0.1",
      );
      assertEquals(updated.has_local_password, true);
      const loggedIn = await loginUser({
        login: result.user.username,
        password: "StrongPass1",
      });
      assertEquals(loggedIn.user.id, result.user.id);
      await assertRejects(
        () => linkPasswordMatches(result.user.id, "wrong-password"),
        Error,
        "密码确认失败",
      );
      await unlinkOAuthAccount(result.user.id, links[0].id);
      assertEquals(
        (await getDb().select().from(oauthAccounts).where(
          eq(oauthAccounts.user_id, result.user.id),
        )).length,
        0,
      );
    } finally {
      restoreEnv();
    }
  },
});

Deno.test({
  name: "oauth: 未同意法律条款时拒绝新建账号，同意后写入同意记录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    setEnv("JWT_SECRET", "oauth-legal-test-secret-that-is-long-enough");
    setEnv("NOJ_ENV", "test");
    try {
      await resetDbForTest();
      const identity = {
        providerUserId: "github-legal-1",
        username: "oauth_legal_user",
        email: "oauth-legal@example.com",
        emailVerified: true,
      };

      // 未同意（acceptedLegal 缺省/ false）→ 拒绝建号
      await assertRejects(
        () =>
          resolveOAuthIdentity("github", identity, "login", undefined, false),
        Error,
        "必须同意服务条款与隐私政策",
      );

      // 先发布两份政策（否则无从记录同意版本）
      const { users: usersTable } = await import(
        "../../../../../shared/db/schema.ts"
      );
      const now = new Date().toISOString();
      const publisherId = "oauth-legal-publisher";
      await getDb().insert(usersTable).values({
        id: publisherId,
        username: "oauth_legal_publisher",
        email: "oauth-legal-publisher@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      }).onConflictDoNothing();
      const { publishVersion, LEGAL_KINDS } = await import(
        "../../../../../features/legal/index.ts"
      );
      for (const kind of LEGAL_KINDS) {
        await publishVersion(
          kind,
          `${kind} 正文`,
          null,
          true,
          userActorFromAuthenticatedId(publisherId),
        );
      }

      // 同意 → 建号成功
      const created = await resolveOAuthIdentity(
        "github",
        identity,
        "login",
        undefined,
        true,
      );
      assertEquals(created.user.has_local_password, false);

      // 同意记录与用户同事务写入（privacy + terms 各一条）
      const { userConsents } = await import(
        "../../../../../shared/db/schema.ts"
      );
      const consents = await getDb().select().from(userConsents).where(
        eq(userConsents.user_id, created.user.id),
      );
      assertEquals(consents.length, 2);
      assertEquals(
        consents.map((r) => r.document_kind).sort(),
        ["privacy", "terms"],
      );
    } finally {
      restoreEnv();
    }
  },
});

// ---------------------------------------------------------------------------
// OAuth 登录与平台封禁：与密码登录同一口径（USER_BANNED，且不记登录成功审计）
// ---------------------------------------------------------------------------

/** 建立 OAuth 身份并返回其用户 ID。 */
async function createOAuthSessionForTest(providerUserId: string) {
  const result = await resolveOAuthIdentity(
    "github",
    {
      providerUserId,
      username: `oauth_ban_${providerUserId.replace(/[^a-z0-9]/gi, "_")}`,
      email: `${providerUserId}@example.com`,
      emailVerified: true,
    },
    "login",
    undefined,
    true,
  );
  return result;
}

/** 为指定用户写入一条活跃封禁记录。 */
async function insertUserBan(
  userId: string,
  values: {
    scope?: "platform" | "social";
    banned_until?: string | null;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(userBans).values({
    id: crypto.randomUUID(),
    user_id: userId,
    reason: "违规行为",
    scope: values.scope ?? "platform",
    banned_until: values.banned_until ?? null,
    banned_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "oauth: 平台封禁用户 OAuth 登录被拒绝（USER_BANNED）且不记登录成功审计",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    setEnv("JWT_SECRET", "oauth-ban-test-secret-that-is-long-enough");
    setEnv("NOJ_ENV", "test");
    try {
      await resetDbForTest();
      const db = getDb();
      await db.delete(auditLogs);
      await db.delete(userBans);
      const created = await createOAuthSessionForTest("github-ban-1");
      await insertUserBan(created.user.id, {});

      const error = await assertRejects(
        () =>
          resolveOAuthIdentity("github", {
            providerUserId: "github-ban-1",
            username: "oauth_ban_user",
            email: "github-ban-1@example.com",
            emailVerified: true,
          }, "login"),
        ForbiddenError,
      );
      assertEquals(error.code, "USER_BANNED");
      assertEquals(error.status, 403);
      assertEquals(error.meta, { reason: "违规行为", until: null });

      // 被封禁用户发起绑定新第三方账号：拒绝，且不得留下绑定关系
      await assertRejects(
        () =>
          resolveOAuthIdentity(
            "github",
            {
              providerUserId: "github-ban-1-link",
              username: "oauth_ban_user",
              email: "github-ban-1@example.com",
              emailVerified: true,
            },
            "link",
            created.user.id,
          ),
        ForbiddenError,
      );
      // 新第三方身份按已验证邮箱命中被封禁用户：拒绝，且不得自动绑定
      await assertRejects(
        () =>
          resolveOAuthIdentity("github", {
            providerUserId: "github-ban-1-email",
            username: "oauth_ban_user",
            email: "github-ban-1@example.com",
            emailVerified: true,
          }, "login"),
        ForbiddenError,
      );
      const bindings = await db.select({
        provider_user_id: oauthAccounts.provider_user_id,
      }).from(oauthAccounts).where(eq(oauthAccounts.user_id, created.user.id));
      assertEquals(bindings.map((row) => row.provider_user_id), [
        "github-ban-1",
      ]);

      // 建号时审计有一条首次登录成功的 login_success（同时含 domain.join）；
      // 三次被拒绝的尝试与密码登录同口径各记一条 login_failure，不记 login_success
      const logs = await db.select().from(auditLogs).where(
        eq(auditLogs.admin_id, created.user.id),
      );
      assertEquals(logs.map((row) => row.action).sort(), [
        "auth.login_failure",
        "auth.login_failure",
        "auth.login_failure",
        "auth.login_success",
        "domain.join",
      ]);
      assertEquals(
        logs.filter((row) => row.action === "auth.login_failure")
          .every((row) =>
            (row.detail as { reason?: string } | null)?.reason ===
              "user_banned"
          ),
        true,
      );
    } finally {
      restoreEnv();
    }
  },
});

Deno.test({
  name: "oauth: 已过期封禁或 social 封禁不影响 OAuth 登录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    setEnv("JWT_SECRET", "oauth-ban-expiry-test-secret-long-enough");
    setEnv("NOJ_ENV", "test");
    try {
      await resetDbForTest();
      const db = getDb();
      await db.delete(auditLogs);
      await db.delete(userBans);
      const created = await createOAuthSessionForTest("github-ban-2");

      // 临时封禁已过期 → 放行
      await insertUserBan(created.user.id, {
        banned_until: new Date(Date.now() - 3600_000).toISOString(),
      });
      const afterExpiry = await resolveOAuthIdentity("github", {
        providerUserId: "github-ban-2",
        username: "oauth_ban_user",
        email: "github-ban-2@example.com",
        emailVerified: true,
      }, "login");
      assertEquals(afterExpiry.user.id, created.user.id);

      // 换一条生效中的 social 封禁 → 只限制社区发布，仍可登录
      await db.delete(userBans);
      await insertUserBan(created.user.id, {
        scope: "social",
        banned_until: new Date(Date.now() + 3600_000).toISOString(),
      });
      const afterSocial = await resolveOAuthIdentity("github", {
        providerUserId: "github-ban-2",
        username: "oauth_ban_user",
        email: "github-ban-2@example.com",
        emailVerified: true,
      }, "login");
      assertEquals(afterSocial.user.id, created.user.id);
    } finally {
      restoreEnv();
    }
  },
});
