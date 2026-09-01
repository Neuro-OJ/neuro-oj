import { assert } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/domains/query/index.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { sql } from "drizzle-orm";

// 性能基准默认不跑：seed 100k problems + 10k users 在每次 PR 上都执行
// 是 CI 的沉重负担（此前混在 core-test 串行里）。仅当 NOJ_RUN_PERF=1
// 时启用（CI 的 core-perf job 在 main push / workflow_dispatch 运行）。
const runPerf = Deno.env.get("NOJ_RUN_PERF") === "1";
const keepPerfData = Deno.env.get("NOJ_PERF_KEEP_DATA") === "1";
const hasExternalDb = Boolean(Deno.env.get("DATABASE_URL"));

if (
  runPerf && hasExternalDb &&
  Deno.env.get("NOJ_PERF_ALLOW_EXTERNAL_DB") !== "1"
) {
  throw new Error(
    "性能基准拒绝使用外部数据库；请设置 NOJ_PERF_ALLOW_EXTERNAL_DB=1 确认该数据库可被清理",
  );
}

Deno.test({
  name: "search perf: 100k problems + 10k users 搜索响应",
  ignore: !runPerf,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    try {
      // Seed 100k problems（分批插入，避免 PGlite OOM）
      const BATCH = 1000;
      const now = new Date().toISOString();
      for (let i = 0; i < 100; i++) {
        const batch = Array.from({ length: BATCH }, (_, j) => ({
          id: `perf-p-${i}-${j}`,
          title: j === 0
            ? `题目 ${i * BATCH + j}：perfuniquekeyword`
            : `题目 ${i * BATCH + j}：常规数据`,
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
          created_at: now,
          updated_at: now,
        }));
        await db.insert(users).values(batch);
      }

      // ANALYZE 让 planner 用上索引统计
      await db.execute(sql`ANALYZE problems`);
      await db.execute(sql`ANALYZE users`);

      // 高选择性题目搜索：100 条命中，验证常见关键词路径。
      const pStart = performance.now();
      const pResult = await searchProblems({
        q: "perfuniquekeyword",
        isAdmin: false,
        page: 1,
        limit: 20,
      });
      const pElapsed = performance.now() - pStart;
      console.log(
        `高选择性题目搜索：${pResult.items.length} 命中，${
          pElapsed.toFixed(0)
        }ms`,
      );
      assert(pElapsed < 500, `高选择性题目搜索 ${pElapsed}ms 超 500ms 阈值`);

      // 全命中题目搜索：100k 条命中，监控最坏情景但允许共享 CI Runner 波动。
      const broadStart = performance.now();
      const broadResult = await searchProblems({
        q: "题目",
        isAdmin: false,
        page: 1,
        limit: 20,
      });
      const broadElapsed = performance.now() - broadStart;
      console.log(
        `全命中题目搜索：${broadResult.items.length} 命中，${
          broadElapsed.toFixed(0)
        }ms`,
      );
      assert(
        broadElapsed < 1200,
        `全命中题目搜索 ${broadElapsed}ms 超 1200ms 阈值`,
      );

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
    } finally {
      if (!keepPerfData) {
        await resetDbForTest();
      }
    }
  },
});
