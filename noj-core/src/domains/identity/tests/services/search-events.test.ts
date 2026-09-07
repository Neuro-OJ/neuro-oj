import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { updateUserProfile } from "../../services/users/users-profile-edit.ts";
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
  name: "identity search event: 更新资料发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-event-1",
      username: "event_user",
      email: "event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await updateUserProfile("u-event-1", "新简介");
    await assertSearchEventPublished("user", "u-event-1", "upsert");
  },
});
