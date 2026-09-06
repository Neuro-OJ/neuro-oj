import { assert } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { searchCommunity } from "../../src/domains/query/index.ts";
import { getDb, resetDbForTest } from "../../src/shared/db/connection.ts";
import {
  communityBoards,
  communityPosts,
  users,
} from "../../src/shared/db/schema.ts";

/**
 * 社区搜索基准默认关闭；仅在隔离的 PostgreSQL 测试库中显式运行。
 *
 * 输出 EXPLAIN (ANALYZE, BUFFERS) 与 P50/P95，供部署前后对比记录。
 */
const runPerf = Deno.env.get("NOJ_RUN_PERF") === "1";
const hasExternalDb = Boolean(Deno.env.get("DATABASE_URL"));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

Deno.test({
  name: "search perf: 100k community posts pg_trgm EXPLAIN + P50/P95",
  ignore: !runPerf || !hasExternalDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();

    await db.insert(users).values({
      id: "community-search-bench-user",
      username: "community_search_bench",
      email: "community-search-bench@example.test",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(communityBoards).values({
      id: "community-search-bench-board",
      slug: "community-search-bench",
      name: "社区搜索基准",
      description: "",
      sort_order: 0,
      is_archived: false,
      created_at: now,
      updated_at: now,
    });

    const batchSize = 1000;
    for (let batch = 0; batch < 100; batch++) {
      await db.insert(communityPosts).values(
        Array.from({ length: batchSize }, (_, offset) => {
          const number = batch * batchSize + offset;
          const isHit = offset === 0;
          return {
            id: `community-search-bench-${number}`,
            public_id: `post-community-bench-${number}`,
            type: "discussion" as const,
            author_id: "community-search-bench-user",
            board_id: "community-search-bench-board",
            title: isHit
              ? `社区搜索 trigram_unique_${number}`
              : `社区帖子 ${number}`,
            content: isHit
              ? "用于验证 pg_trgm 索引的高选择性关键词。"
              : "常规基准数据。",
            status: "published" as const,
            created_at: now,
            updated_at: now,
          };
        }),
      );
    }

    await db.execute(sql`ANALYZE community_posts`);
    const explain = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id
      FROM community_posts
      WHERE status = 'published'
        AND type IN ('solution', 'discussion')
        AND (title ILIKE '%trigram_unique_0%' OR content ILIKE '%trigram_unique_0%')
    `);
    console.log("社区搜索 EXPLAIN:", JSON.stringify(explain));

    const elapsed: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const result = await searchCommunity({
        q: "trigram_unique_0",
        page: 1,
        limit: 20,
      });
      elapsed.push(performance.now() - start);
      assert(result.items.length > 0);
    }
    console.log(
      `社区搜索 pg_trgm P50=${percentile(elapsed, 0.5).toFixed(1)}ms ` +
        `P95=${percentile(elapsed, 0.95).toFixed(1)}ms`,
    );

    await resetDbForTest();
  },
});
