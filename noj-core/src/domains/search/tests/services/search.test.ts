import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { upsertSearchEntry } from "../../services/index-writer.ts";
import {
  buildProblemEntry,
  buildUserEntry,
} from "../../services/index-writer.ts";
import { searchFlat, searchGrouped } from "../../services/search.ts";

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: "p-search-1",
    title: "动态规划",
    description: "入门",
    difficulty: "medium",
    runtime_config: {
      evaluator: {
        image: "x",
        command: "x",
        time_limit_ms: 1000,
        memory_limit_mb: 128,
      },
      solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
    },
    number: 1,
    type: "P",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: "u-search-1",
    username: "alice",
    email: "alice@example.com",
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await upsertSearchEntry((await buildProblemEntry("p-search-1"))!);
  await upsertSearchEntry((await buildUserEntry("u-search-1"))!);
}

Deno.test({
  name: "search service: grouped 返回题目且匿名可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchGrouped({
      q: "动态",
      types: ["problem", "user"],
      perType: 5,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(result.groups.problem.items.length, 1);
    assertEquals(result.groups.user.items.length, 0);
  },
});

Deno.test({
  name: "search service: flat 管理员可搜用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchFlat({
      q: "alice",
      type: "user",
      page: 1,
      perPage: 20,
      ctx: { userId: "admin", isAdmin: true, guestReadEnabled: true },
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.entity_type, "user");
  },
});

Deno.test({
  name: "search service: message 对已删除该消息的用户不可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const now = new Date().toISOString();
    await upsertSearchEntry({
      entityType: "message",
      entityId: "msg-perm-1",
      title: "私信秘密",
      body: "只有另一方能搜到",
      metadata: { conversation_id: "conv-perm-1" },
      participantIds: ["u-del-a", "u-del-b"],
      deletedByUserIds: ["u-del-a"],
      isPublic: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const visibleForB = await searchFlat({
      q: "秘密",
      type: "message",
      page: 1,
      perPage: 20,
      ctx: { userId: "u-del-b", isAdmin: false, guestReadEnabled: true },
    });
    const hiddenForA = await searchFlat({
      q: "秘密",
      type: "message",
      page: 1,
      perPage: 20,
      ctx: { userId: "u-del-a", isAdmin: false, guestReadEnabled: true },
    });
    const hiddenForAnonymous = await searchFlat({
      q: "秘密",
      type: "message",
      page: 1,
      perPage: 20,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(visibleForB.items.length, 1);
    assertEquals(hiddenForA.items.length, 0);
    assertEquals(hiddenForAnonymous.items.length, 0);
  },
});
