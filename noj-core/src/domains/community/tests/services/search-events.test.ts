import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { createBoard } from "../../services/community/community-boards.ts";
import { createPost } from "../../services/community/community-post-crud.ts";
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
  name: "community search event: 创建帖子发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-community-event",
      username: "community_event",
      email: "community-event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const board = await createBoard({ slug: "event-board", name: "事件板块" });
    const post = await createPost("u-community-event", {
      type: "discussion",
      board_id: board.id,
      title: "事件帖子",
      content: "内容",
    });
    await assertSearchEventPublished("community_post", post.id, "upsert");
  },
});
