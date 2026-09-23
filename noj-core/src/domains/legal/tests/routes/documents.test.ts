/**
 * legal 域公开路由测试。
 *
 * 覆盖：当前文档列表（未发布为 null）、发布后返回、非法 kind 400、版本历史。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { publishVersion } from "../../index.ts";
import { createApp } from "../../../../app.ts";

const PUBLISHER = "legal-route-publisher";

/** 构造测试用户（发布者 FK）。 */
async function seedPublisher() {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id: PUBLISHER,
      username: "legal-route-pub",
      email: "legal-route-pub@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
}

Deno.test({
  name: "legal routes: 未发布时 documents 返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/legal/documents");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.privacy, null);
    assertEquals(body.data.terms, null);
  },
});

Deno.test({
  name: "legal routes: 发布后返回当前版本且支持版本历史",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await seedPublisher();
    await publishVersion("privacy", "隐私第一版", null, true, PUBLISHER);
    await publishVersion("privacy", "隐私第二版", "修订", false, PUBLISHER);

    const app = createApp();
    const docRes = await app.request("/api/v1/legal/documents");
    const body = await docRes.json();
    assertEquals(body.data.privacy.version, 2);
    assertEquals(body.data.privacy.content, "隐私第二版");

    const verRes = await app.request(
      "/api/v1/legal/documents/privacy/versions",
    );
    const verBody = await verRes.json();
    assertEquals(verBody.data.length, 2);
    assertEquals(verBody.data[0].version, 2);
  },
});

Deno.test({
  name: "legal routes: 非法 kind 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/legal/documents/bogus/versions");
    assertEquals(res.status, 400);
  },
});
