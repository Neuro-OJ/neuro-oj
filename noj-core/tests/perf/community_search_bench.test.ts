import { assert } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { reindexAll, searchFlat } from "../../src/domains/search/index.ts";
import { getDb, resetDbForTest } from "../../src/shared/db/connection.ts";
import {
  communityBoards,
  communityPosts,
  users,
} from "../../src/shared/db/schema.ts";

/**
 * 社区搜索基准默认关闭；仅在隔离的 PostgreSQL 测试库中显式运行。
 *
 * 输出 search_entries EXPLAIN (ANALYZE, BUFFERS) 与 P50/P95，供部署前后对比记录。
 */
const runPerf = Deno.env.get("NOJ_RUN_PERF") === "1";
const hasExternalDb = Boolean(Deno.env.get("DATABASE_URL"));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

Deno.test({
  name: "search perf: 100k community posts search_entries EXPLAIN + P50/P95",
  ignore: !runPerf || !hasExternalDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const ctx = { userId: undefined, isAdmin: false, guestReadEnabled: true };
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

    // 将源数据同步到统一搜索索引表，确保基准测量的是 search_entries 新路径
    await reindexAll();

    await db.execute(sql`ANALYZE community_posts`);
    await db.execute(sql`ANALYZE search_entries`);
    // 与 searchFlat 的真实查询保持一致（search_entries 统一索引表），
    // 避免 EXPLAIN 只验证简化查询而实际搜索仍走其他路径。
    const explain = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, entity_type, entity_id, title,
        ts_rank(search_vector, websearch_to_tsquery('simple', 'trigram_unique_0')) AS rank,
        ts_headline('simple', title, websearch_to_tsquery('simple', 'trigram_unique_0'),
          'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
        ) AS highlight,
        metadata
      FROM search_entries
      WHERE is_active = true
        AND (
          search_vector @@ websearch_to_tsquery('simple', 'trigram_unique_0')
          OR title ILIKE '%trigram_unique_0%' ESCAPE '\\'
          OR body ILIKE '%trigram_unique_0%' ESCAPE '\\'
        )
        AND (
          (is_public = true OR owner_id = '' OR '' = ANY(participant_ids) OR false)
          AND (admin_only = false OR false)
        )
        AND true
        AND entity_type = 'community_post'
      ORDER BY rank DESC NULLS LAST, updated_at DESC
      LIMIT 21
    `);
    console.log("社区搜索 EXPLAIN:", JSON.stringify(explain));

    const elapsed: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const result = await searchFlat({
        q: "trigram_unique_0",
        type: "community_post",
        page: 1,
        perPage: 20,
        ctx,
      });
      elapsed.push(performance.now() - start);
      assert(result.items.length > 0);
    }
    console.log(
      `社区搜索 search_entries P50=${percentile(elapsed, 0.5).toFixed(1)}ms ` +
        `P95=${percentile(elapsed, 0.95).toFixed(1)}ms`,
    );

    await resetDbForTest();
  },
});
