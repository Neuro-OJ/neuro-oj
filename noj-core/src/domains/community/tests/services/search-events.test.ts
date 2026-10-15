import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { createBoard } from "../../services/community/community-boards.ts";
import { createPost } from "../../services/community/community-post-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { SEARCH_INDEX_QUEUE } from "../../../../shared/search-events.ts";
import { withDomainCommunity } from "../../index.ts";
import { domainFixture } from "./domain-fixture.ts";

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
    // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
    // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
    // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
    const post = await createPost("u-community-event", {
      type: "discussion",
      board_id: board.id,
      title: "事件帖子",
      content: "内容",
    });
    await assertSearchEventPublished("community_post", post.id, "upsert");
  },
});

Deno.test({
  name: "community search event: 授权事务完成前不发布，完成后才进入索引队列",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await domainFixture("search-after-commit");
    const post = await withDomainCommunity(f.source.slug, f.a, {
      write: true,
      permission: "community:create",
    }, async (scope) => {
      const post = await createPost(
        f.a,
        {
          type: "discussion",
          board_id: f.boardA.id,
          title: "提交后才索引",
          content: "内容",
        },
        true,
        scope,
      );
      const queued = await getRedis().lrange(SEARCH_INDEX_QUEUE, 0, -1);
      assertEquals(
        queued.some((value) => JSON.parse(value).entityId === post.id),
        false,
        "不能让消费者在事务完成前读取本次帖子",
      );
      return post;
    });
    await assertSearchEventPublished("community_post", post.id, "upsert");
  },
});

Deno.test({
  name: "community search event: 授权事务回滚不发布索引事件",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await domainFixture("search-rollback");
    let postId = "";
    await assertRejects(
      () =>
        withDomainCommunity(f.source.slug, f.a, {
          write: true,
          permission: "community:create",
        }, async (scope) => {
          const post = await createPost(
            f.a,
            {
              type: "discussion",
              board_id: f.boardA.id,
              title: "回滚帖子",
              content: "内容",
            },
            true,
            scope,
          );
          postId = post.id;
          throw new Error("测试回滚");
        }),
      Error,
      "测试回滚",
    );
    const queued = await getRedis().lrange(SEARCH_INDEX_QUEUE, 0, -1);
    assertEquals(
      queued.some((value) => JSON.parse(value).entityId === postId),
      false,
    );
  },
});
