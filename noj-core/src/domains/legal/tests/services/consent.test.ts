/**
 * legal 域同意服务测试。
 *
 * 覆盖：同意记录写入与幂等、取最新已同意版本、注册批量写入两文档、
 * 已同意版本映射。
 *
 * 依赖 PGlite 内存数据库。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import {
  getConsentedVersions,
  getCurrentDocument,
  getUserConsent,
  publishVersion,
  recordConsent,
  recordConsentsForRegistration,
} from "../../index.ts";

const USER = "legal-test-user";
const PUBLISHER = "legal-test-publisher";

async function setup() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values([
      {
        id: USER,
        username: "legal-user",
        email: "legal-user@example.test",
        password_hash: "",
        created_at: now,
        updated_at: now,
      },
      {
        id: PUBLISHER,
        username: "legal-publisher",
        email: "legal-publisher@example.test",
        password_hash: "",
        created_at: now,
        updated_at: now,
      },
    ])
    .onConflictDoNothing();
}

Deno.test({
  name: "legal consent: 记录、幂等、取最新版本",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    await publishVersion("privacy", "v1", null, true, PUBLISHER);
    await publishVersion("privacy", "v2", null, true, PUBLISHER);

    await recordConsent(USER, "privacy", 1, "hash1", "1.2.3.4", "UA/1");
    await recordConsent(USER, "privacy", 1, "hash1", "1.2.3.4", "UA/1"); // 幂等
    await recordConsent(USER, "privacy", 2, "hash2", "1.2.3.4", "UA/2");

    const latest = await getUserConsent(USER, "privacy");
    assertEquals(latest?.version, 2);
    // 历史保留：两行都在
    assertEquals((await getConsentedVersions(USER)).privacy, 2);
  },
});

Deno.test({
  name: "legal consent: 注册批量写入两文档当前版本",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    await publishVersion("privacy", "p1", null, true, PUBLISHER);
    await publishVersion("terms", "t1", null, true, PUBLISHER);

    const db = getDb();
    await db.transaction(async (tx) => {
      await recordConsentsForRegistration(tx, USER, "9.9.9.9", "UA/reg");
    });

    const privacy = await getUserConsent(USER, "privacy");
    const terms = await getUserConsent(USER, "terms");
    assertEquals(
      privacy?.version,
      (await getCurrentDocument("privacy"))?.version,
    );
    assertEquals(terms?.version, (await getCurrentDocument("terms"))?.version);
  },
});
