import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";
import { oauthAccounts, users } from "./../../src/shared/db/schema.ts";
import { loginUser } from "../../src/domains/identity/index.ts";
import { setPassword } from "../../src/domains/identity/index.ts";
import {
  linkPasswordMatches,
  resolveOAuthIdentity,
  unlinkOAuthAccount,
} from "../../src/domains/identity/index.ts";

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
      const result = await resolveOAuthIdentity("github", {
        providerUserId: "github-identity-1",
        username: "oauth_test_user",
        email: "oauth-test@example.com",
        emailVerified: true,
      }, "login");

      assertEquals(result.user.has_local_password, false);
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
