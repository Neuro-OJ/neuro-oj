import { assert } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/services/search.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { sql } from "drizzle-orm";

await resetDbForTest();

Deno.test({
  name: "search perf: 100k problems + 10k users 搜索响应 < 500ms",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    // Seed 100k problems（分批插入，避免 PGlite OOM）
    const BATCH = 1000;
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      const batch = Array.from({ length: BATCH }, (_, j) => ({
        id: `perf-p-${i}-${j}`,
        title: `题目 ${i * BATCH + j}：测试数据`,
        description: "",
        difficulty: "medium",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },

          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
        number: i * BATCH + j + 1,
        type: "P" as const,
        created_at: now,
        updated_at: now,
      }));
      await db.insert(problems).values(batch);
    }

    // Seed 10k users
    for (let i = 0; i < 10; i++) {
      const batch = Array.from({ length: 1000 }, (_, j) => ({
        id: `perf-u-${i}-${j}`,
        username: `user_${i * 1000 + j}`,
        email: `user_${i}_${j}@perf.test`,
        password_hash: "x",
        role: "user",
        created_at: now,
        updated_at: now,
      }));
      await db.insert(users).values(batch);
    }

    // ANALYZE 让 planner 用上索引统计
    await db.execute(sql`ANALYZE problems`);
    await db.execute(sql`ANALYZE users`);

    // 题目搜索基准
    const pStart = performance.now();
    const pResult = await searchProblems({
      q: "测试",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    const pElapsed = performance.now() - pStart;
    console.log(
      `题目搜索：${pResult.items.length} 命中，${pElapsed.toFixed(0)}ms`,
    );
    assert(pElapsed < 500, `题目搜索 ${pElapsed}ms 超 500ms 阈值`);

    // 用户搜索基准
    const uStart = performance.now();
    const uResult = await searchUsers({
      q: "user_1",
      isAdmin: true,
      page: 1,
      limit: 20,
    });
    const uElapsed = performance.now() - uStart;
    console.log(
      `用户搜索：${uResult.items.length} 命中，${uElapsed.toFixed(0)}ms`,
    );
    assert(uElapsed < 500, `用户搜索 ${uElapsed}ms 超 500ms 阈值`);
  },
});
