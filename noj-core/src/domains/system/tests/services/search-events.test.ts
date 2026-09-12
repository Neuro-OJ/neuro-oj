import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { createAnnouncement } from "../../services/announcements.ts";
import { enterTestContext, leaveTestContext } from "../../index.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

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
      // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
      // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
      // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
      // 同一个 Redis 键，删除动作会把对方正在等待观测的事件一并删掉（实测：全量
      // 分片运行必现 2 个假失败，单文件运行必过）。断言查找的是本次生成的唯一
      // entityId，历史事件不会造成误判，因此无需清空。
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
