import { assert } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { reindexAll } from "../../services/index-writer.ts";
import { searchFlat } from "../../services/search.ts";

// 性能基准默认不跑：seed 100k 行在每次 PR 上都执行是 CI 的沉重负担。
// 仅当 NOJ_RUN_PERF=1 时启用，与 noj-core/tests/perf/* 的守卫方式一致。
const runPerf = Deno.env.get("NOJ_RUN_PERF") === "1";

Deno.test({
  name: "search perf: 10 万题重建后搜索 < 500ms",
  ignore: !runPerf,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const BATCH = 1000;
    for (let i = 0; i < 100; i++) {
      const batch = Array.from({ length: BATCH }, (_, j) => ({
        id: `perf-p-${i}-${j}`,
        title: `题目 ${i * BATCH + j}：测试数据`,
        description: "",
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
        number: i * BATCH + j + 1,
        type: "P" as const,
        visibility: "public",
        created_at: now,
        updated_at: now,
      }));
      await db.insert(problems).values(batch);
    }
    await reindexAll();
    const start = performance.now();
    const result = await searchFlat({
      q: "测试",
      page: 1,
      perPage: 20,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    const elapsed = performance.now() - start;
    console.log(
      `搜索耗时 ${elapsed.toFixed(0)}ms，命中 ${result.items.length}`,
    );
    assert(elapsed < 500, `搜索 ${elapsed}ms 超 500ms 阈值`);
  },
});
