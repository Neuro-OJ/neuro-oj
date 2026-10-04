import { assertEquals } from "jsr:@std/assert@^1";
import type { Db } from "../src/db.ts";
import { pruneUsage, runUsageRetention } from "../src/usage.ts";
import { FakeRedis } from "./helpers.ts";

/** 记录 DELETE 调用参数的 fake Db；按 batches 依次返回各批删除行数。 */
function createPruneDb(batches: number[]) {
  const calls: unknown[][] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("DELETE FROM llm_usage")) {
      calls.push(values);
      const n = batches.shift() ?? 0;
      return Promise.resolve(Array.from({ length: n }, (_, i) => ({ id: i })));
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  return { db, calls };
}

Deno.test("usage retention: 按保留天数计算截止时间并分批删除至不足一批", async () => {
  const { db, calls } = createPruneDb([5000, 5000, 12]);
  const now = new Date("2026-10-04T00:00:00.000Z");
  const deleted = await pruneUsage(db, 90, now);
  assertEquals(deleted, 10012);
  assertEquals(calls.length, 3);
  assertEquals(calls[0][0], "2026-07-06T00:00:00.000Z");
});

Deno.test("usage retention: 保留天数为 0 时不执行任何删除", async () => {
  const { db, calls } = createPruneDb([10]);
  assertEquals(await pruneUsage(db, 0), 0);
  assertEquals(calls.length, 0);
});

Deno.test("usage retention: 多副本经 Redis 锁互斥，同一轮只执行一次", async () => {
  const { db, calls } = createPruneDb([3, 3]);
  const redis = new FakeRedis();
  assertEquals(await runUsageRetention(db, redis, 90), 3);
  // 第二个副本抢不到锁
  assertEquals(await runUsageRetention(db, redis, 90), 0);
  assertEquals(calls.length, 1);
});
