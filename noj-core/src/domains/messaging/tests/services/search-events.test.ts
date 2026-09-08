import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import {
  findOrCreateConversation,
  sendMessage,
} from "../../services/messages.ts";
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
  name: "messaging search event: 发送消息发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values([
      {
        id: "u-msg-1",
        username: "msg1",
        email: "msg1@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      },
      {
        id: "u-msg-2",
        username: "msg2",
        email: "msg2@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      },
    ]);
    const { conversation } = await findOrCreateConversation(
      "u-msg-1",
      "u-msg-2",
    );
    await getRedis().del(SEARCH_INDEX_QUEUE);
    const message = await sendMessage("u-msg-1", conversation.id, "你好");
    await assertSearchEventPublished("message", message.id, "upsert");
  },
});
