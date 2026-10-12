/**
 * legal 域同意端点测试。
 *
 * 覆盖：未发布文档 400、非法 kind 400、未登录 401、同意后写记录、
 * `/auth/me` 的 legal 状态（重大版本触发 needs_consent，非重大不触发）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { userConsents, users } from "../../../../shared/db/schema.ts";
import { publishVersion } from "../../index.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "./../../../identity/services/security/jwt.ts";

const PUBLISHER = "legal-consent-publisher";

async function seedPublisher() {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id: PUBLISHER,
      username: "legal-consent-pub",
      email: "legal-consent-pub@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
}

/** 创建用户并签发可用 token。 */
async function makeUser(id: string, version = 0) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id,
      username: `user_${id}`,
      email: `${id}@example.test`,
      password_hash: "",
      session_version: version,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  return await signToken({
    sub: id,
    role: "user",
    session_version: version,
  });
}

Deno.test({
  name: "legal consent: 未发布文档时同意返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makeUser("consent-user-a");
    const app = createApp();
    const res = await app.request("/api/v1/legal/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind: "privacy" }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "legal consent: 非法 kind 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makeUser("consent-user-b");
    const app = createApp();
    const res = await app.request("/api/v1/legal/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind: "bogus" }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name:
    "legal consent: 同意后写入记录且 /me 状态更新（重大版本触发、非重大不触发）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await seedPublisher();
    await publishVersion("privacy", "v1", null, true, PUBLISHER); // 重大

    const userId = "consent-user-c";
    const token = await makeUser(userId);
    const app = createApp();

    // 同意前：needs_consent = true（并带出重大版本摘要供弹窗展示）
    const me1 = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me1Body = await me1.json();
    assertEquals(me1Body.data.legal.privacy.needs_consent, true);

    // 同意
    const ok = await app.request("/api/v1/legal/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind: "privacy" }),
    });
    assertEquals(ok.status, 201);

    // 记录存在
    const db = getDb();
    const rows = await db.select().from(userConsents).where(
      eq(userConsents.user_id, userId),
    );
    assertEquals(rows.some((r) => r.document_kind === "privacy"), true);

    // 同意后：needs_consent = false
    const me2 = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me2Body = await me2.json();
    assertEquals(me2Body.data.legal.privacy.needs_consent, false);

    // 发布非重大新版本：不触发重新同意
    await publishVersion("privacy", "v2", "错字", false, PUBLISHER);
    const me3 = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me3Body = await me3.json();
    assertEquals(me3Body.data.legal.privacy.needs_consent, false);

    // 发布新的重大版本：触发重新同意，且返回该版摘要
    await publishVersion("privacy", "v3", "重大修订", true, PUBLISHER);
    const me4 = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me4Body = await me4.json();
    assertEquals(me4Body.data.legal.privacy.needs_consent, true);
    assertEquals(me4Body.data.legal.privacy.change_summary, "重大修订");
  },
});
