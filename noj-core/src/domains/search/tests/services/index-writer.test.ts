import { assert, assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  conversations,
  messageDeletions,
  messages,
  problems,
  searchEntries,
  users,
} from "../../../../shared/db/schema.ts";
import {
  buildContestEntry,
  buildMessageEntry,
  buildProblemEntry,
  buildUserEntry,
  deleteSearchEntry,
  processSearchIndexEvent,
  reindexAll,
  upsertSearchEntry,
} from "../../services/index-writer.ts";
import { sql } from "drizzle-orm";

await resetDbForTest();

Deno.test({
  name: "index-writer: upsert 后可按 entity 查到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
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
    const entry = await buildProblemEntry("p-search-1");
    assertEquals(entry !== null, true);
    await upsertSearchEntry(entry!);
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-search-1'`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.title, "动态规划");
  },
});

Deno.test({
  name: "index-writer: upsert 后 search_vector 由生成列自动填充",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await upsertSearchEntry({
      entityType: "problem",
      entityId: "p-vector-1",
      title: "生成向量测试",
      body: "hello world",
      metadata: {},
      isPublic: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db.select({
      searchVector: searchEntries.searchVector,
    }).from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-vector-1'`,
    );
    assertEquals(rows.length, 1);
    assert(rows[0]?.searchVector !== null);
    assert((rows[0]?.searchVector ?? "").length > 0);
  },
});

Deno.test({
  name: "index-writer: delete 后条目消失",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-1",
      username: "alice",
      email: "alice@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildUserEntry("u-search-1");
    await upsertSearchEntry(entry!);
    await deleteSearchEntry("user", "u-search-1");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-1'`,
    );
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "index-writer: processSearchIndexEvent delete 时源仍存在则转 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-2",
      username: "bob",
      email: "bob@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await processSearchIndexEvent("user", "u-search-2", "delete");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-2'`,
    );
    assertEquals(rows.length, 1);
  },
});

Deno.test({
  name: "index-writer: buildMessageEntry 携带删除者列表",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values([
      {
        id: "u-msg-del-a",
        username: "del_a",
        email: "del_a@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      },
      {
        id: "u-msg-del-b",
        username: "del_b",
        email: "del_b@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(conversations).values({
      id: "conv-msg-del",
      user1_id: "u-msg-del-a",
      user2_id: "u-msg-del-b",
      last_message_at: now,
      created_at: now,
    });
    await db.insert(messages).values({
      id: "msg-del-1",
      conversation_id: "conv-msg-del",
      sender_id: "u-msg-del-a",
      content: "这条消息已被一方删除",
      created_at: now,
    });
    await db.insert(messageDeletions).values({
      user_id: "u-msg-del-a",
      message_id: "msg-del-1",
      deleted_at: now,
    });
    const entry = await buildMessageEntry("msg-del-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.deletedByUserIds, ["u-msg-del-a"]);
  },
});

Deno.test({
  name: "index-writer: buildContestEntry 包含关联题目名",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: "p-contest-entry",
      title: "竞赛关联题",
      description: "desc",
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
      number: 7,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: "contest-entry-1",
      title: "题目关联竞赛",
      description: "竞赛描述",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-01-02T00:00:00.000Z",
      type: "kaggle",
      kind: "public",
      is_public: true,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: "contest-entry-1",
      problem_id: "p-contest-entry",
      sort_order: 0,
      label: "A",
      score: 100,
    });
    const entry = await buildContestEntry("contest-entry-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.metadata.problem_titles, ["竞赛关联题"]);
    assertEquals(entry?.metadata.problem_display_ids, ["P7"]);
    assert(entry!.body.includes("竞赛关联题"));
  },
});

Deno.test({
  name: "index-writer: reindexAll 不整体清空索引，只删除 stale",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: "p-search-keep",
      title: "保留题",
      description: "desc",
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "x",
          command: "x",
          time_limit_ms: 1000,
          memory_limit_mb: 128,
        },
        solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
      },
      number: 2,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await upsertSearchEntry({
      entityType: "problem",
      entityId: "p-search-keep",
      title: "保留题",
      body: "",
      metadata: {},
      isPublic: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    await upsertSearchEntry({
      entityType: "problem",
      entityId: "p-stale",
      title: "旧题",
      body: "",
      metadata: {},
      isPublic: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const counts = await reindexAll();
    assertEquals(counts.problem, 1);
    const keepRows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-search-keep'`,
    );
    const staleRows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-stale'`,
    );
    assertEquals(keepRows.length, 1);
    assertEquals(staleRows.length, 0);
  },
});
