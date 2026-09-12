import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import {
  adminUpdateUserProfile,
  updateUserProfile,
} from "../../services/users/users-profile-edit.ts";
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
    // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
    // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
    // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
    await updateUserProfile("u-event-1", "新简介");
    await assertSearchEventPublished("user", "u-event-1", "upsert");
  },
});

Deno.test({
  name: "identity search event: 管理员更新用户资料发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-admin-event-1",
      username: "admin_event_user",
      email: "admin-event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await adminUpdateUserProfile("u-admin-event-1", {
      bio: "管理员更新的简介",
    });
    await assertSearchEventPublished("user", "u-admin-event-1", "upsert");
  },
});
