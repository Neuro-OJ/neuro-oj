import { assert, assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  announcements,
  communityBoards,
  communityComments,
  communityPosts,
  contestProblems,
  contests,
  conversations,
  messageDeletions,
  messages,
  problems,
  searchEntries,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  buildAnnouncementEntry,
  buildCommunityCommentEntry,
  buildCommunityPostEntry,
  buildContestEntry,
  buildMessageEntry,
  buildProblemEntry,
  buildSubmissionEntry,
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
    assertEquals(entry?.participantIds, ["u-msg-del-a", "u-msg-del-b"]);
    assertEquals(entry?.deletedByUserIds, ["u-msg-del-a"]);
  },
});

Deno.test({
  name: "index-writer: buildCommunityPostEntry 公开帖子索引字段",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-post-author",
      username: "post_author",
      email: "post_author@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityBoards).values({
      id: "board-post-entry",
      slug: "post-entry-board",
      name: "搜索测试板块",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityPosts).values({
      id: "post-entry-1",
      type: "discussion",
      author_id: "u-post-author",
      board_id: "board-post-entry",
      title: "社区帖子标题",
      content: "社区帖子正文",
      status: "published",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildCommunityPostEntry("post-entry-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.entityType, "community_post");
    assertEquals(entry?.title, "社区帖子标题");
    assert(entry!.body.includes("社区帖子正文"));
    assert(entry!.body.includes("post_author"));
    assert(typeof entry?.metadata.public_id === "string");
    assertEquals((entry?.metadata.public_id as string).length > 0, true);
    assertEquals(entry?.metadata.author_username, "post_author");
    assertEquals(entry?.isPublic, true);
    assertEquals(entry?.isActive, true);
  },
});

Deno.test({
  name: "index-writer: buildCommunityCommentEntry 携带帖子公开 ID",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-comment-author",
      username: "comment_author",
      email: "comment_author@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityBoards).values({
      id: "board-comment-entry",
      slug: "comment-entry-board",
      name: "评论测试板块",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityPosts).values({
      id: "post-comment-entry",
      type: "discussion",
      author_id: "u-comment-author",
      board_id: "board-comment-entry",
      title: "评论目标帖",
      content: "评论目标正文",
      status: "published",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityComments).values({
      id: "comment-entry-1",
      post_id: "post-comment-entry",
      author_id: "u-comment-author",
      content: "这是一条评论",
      status: "published",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildCommunityCommentEntry("comment-entry-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.entityType, "community_comment");
    assert(entry!.body.includes("这是一条评论"));
    assertEquals(entry?.metadata.post_id, "post-comment-entry");
    assert(typeof entry?.metadata.post_public_id === "string");
    assertEquals((entry?.metadata.post_public_id as string).length > 0, true);
    assertEquals(entry?.isPublic, true);
    assertEquals(entry?.isActive, true);
  },
});

Deno.test({
  name: "index-writer: buildSubmissionEntry 包含题目与拥有者",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-sub-entry",
      username: "sub_entry",
      email: "sub_entry@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: "p-sub-entry",
      title: "提交索引题",
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
      number: 31,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await db.insert(submissions).values({
      id: "sub-entry-1",
      user_id: "u-sub-entry",
      problem_id: "p-sub-entry",
      language: "python",
      code: "print(1)",
      status: "finished",
      created_at: now,
    });
    const entry = await buildSubmissionEntry("sub-entry-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.entityType, "submission");
    assertEquals(entry?.title, "提交索引题 - sub_entry");
    assert(entry!.body.includes("python"));
    assert(entry!.body.includes("finished"));
    assertEquals(entry?.ownerId, "u-sub-entry");
    assertEquals(entry?.isPublic, false);
  },
});

Deno.test({
  name: "index-writer: buildAnnouncementEntry 公开且激活",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-ann-owner",
      username: "ann_owner",
      email: "ann_owner@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(announcements).values({
      id: "ann-entry-1",
      title: "公告标题",
      content: "公告正文",
      is_active: true,
      created_by: "u-ann-owner",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildAnnouncementEntry("ann-entry-1");
    assertEquals(entry !== null, true);
    assertEquals(entry?.entityType, "announcement");
    assertEquals(entry?.title, "公告标题");
    assertEquals(entry?.body, "公告正文");
    assertEquals(entry?.isPublic, true);
    assertEquals(entry?.isActive, true);
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
