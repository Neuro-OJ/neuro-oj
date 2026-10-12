import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { oauthAccounts, users } from "../../../../shared/db/schema.ts";
import { ADMIN_INITIALIZATION_KEY } from "../../../../shared/security/admin-initialization.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import { loginUser } from "../../index.ts";
import { setPassword } from "../../index.ts";
import {
  linkPasswordMatches,
  resolveOAuthIdentity,
  unlinkOAuthAccount,
} from "../../index.ts";

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
        "../../../../shared/db/schema.ts"
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
        "../../../legal/index.ts"
      );
      for (const kind of LEGAL_KINDS) {
        await publishVersion(kind, `${kind} 正文`, null, true, publisherId);
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
        "../../../../shared/db/schema.ts"
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
