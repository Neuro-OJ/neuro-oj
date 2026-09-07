import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { createAnnouncement } from "../../services/announcements.ts";
import { enterTestContext, leaveTestContext } from "../../index.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { SEARCH_INDEX_QUEUE } from "../../../../shared/search-events.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "system search event: 创建公告发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    leaveTestContext();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "test-admin-uuid",
      username: "test-admin",
      email: "test-admin@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    enterTestContext({
      actorId: "test-admin-uuid",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await getRedis().del(SEARCH_INDEX_QUEUE);
      const announcement = await createAnnouncement({
        title: "事件公告",
        content: "内容",
      });
      await assertSearchEventPublished(
        "announcement",
        announcement.id,
        "upsert",
      );
    } finally {
      leaveTestContext();
    }
  },
});
