/**
 * legal 域文档服务测试。
 *
 * 覆盖：内容哈希稳定性与规范化、版本发布递增、`getRequiredConsentVersion`
 * 只认重大版本、版本历史、空内容校验。
 *
 * 依赖 PGlite 内存数据库（无 DATABASE_URL 也可运行）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { ValidationError } from "../../../../shared/base/errors.ts";
import {
  getCurrentDocument,
  getRequiredConsentVersion,
  hashContent,
  listVersions,
  publishVersion,
} from "../../index.ts";

const PUBLISHER = "legal-test-publisher";

/** 重置 DB 并插入发布者用户（created_by FK 需要）。 */
async function setup() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id: PUBLISHER,
      username: "legal-publisher",
      email: "legal-publisher@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
}

Deno.test({
  name: "legal documents: hashContent 规范化（CRLF 与首尾空白不影响哈希）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const a = await hashContent("hello\nworld");
    const b = await hashContent("  hello\r\nworld  ");
    assertEquals(a, b);
    assertEquals(a.length, 64); // SHA-256 hex
  },
});

Deno.test({
  name: "legal documents: 未发布时 current=null、required=0",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    assertEquals(await getCurrentDocument("privacy"), null);
    assertEquals(await getRequiredConsentVersion("privacy"), 0);
    assertEquals(await listVersions("privacy"), []);
  },
});

Deno.test({
  name: "legal documents: 发布版本递增且当前版本为最新",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    const v1 = await publishVersion("terms", "第一版", null, false, PUBLISHER);
    assertEquals(v1, 1);
    const v2 = await publishVersion(
      "terms",
      "第二版",
      "改错字",
      false,
      PUBLISHER,
    );
    assertEquals(v2, 2);
    const cur = await getCurrentDocument("terms");
    assertEquals(cur?.version, 2);
    assertEquals(cur?.content, "第二版");
    assertEquals((await listVersions("terms")).length, 2);
  },
});

Deno.test({
  name: "legal documents: getRequiredConsentVersion 只认重大版本",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    await publishVersion("privacy", "v1", null, true, PUBLISHER); // 重大
    assertEquals(await getRequiredConsentVersion("privacy"), 1);
    await publishVersion("privacy", "v2", null, false, PUBLISHER); // 非重大
    assertEquals(await getRequiredConsentVersion("privacy"), 1); // 不变
    await publishVersion("privacy", "v3", null, true, PUBLISHER); // 重大
    assertEquals(await getRequiredConsentVersion("privacy"), 3);
  },
});

Deno.test({
  name: "legal documents: 空内容拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    await assertRejects(
      () => publishVersion("privacy", "   ", null, false, PUBLISHER),
      ValidationError,
    );
  },
});
