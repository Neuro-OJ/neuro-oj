/**
 * 分页解析属性测试：随机输入下不崩溃且结果在合法范围。
 *
 * parsePagination 接收 Hono Context，因此用最小 fake context 包装随机 query。
 * 合法输入应收敛到 page≥1、perPage∈[1,100]；非法输入应抛 ValidationError。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parsePagination } from "../../src/shared/http/pagination.ts";
import type { Context } from "hono";

function makeCtx(
  query: Record<string, string | undefined>,
): Context {
  return {
    req: {
      query: (key: string) => query[key],
    },
  } as unknown as Context;
}

/** 固定种子 PRNG（mulberry32）：失败可复现，避免不可重跑的随机属性测试。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("property: parsePagination 合法输入按值映射", () => {
  const result = parsePagination(makeCtx({ page: "5", per_page: "30" }));
  assertEquals(result.page, 5);
  assertEquals(result.perPage, 30);
  // 超过上限收敛到 100
  assertEquals(parsePagination(makeCtx({ per_page: "1000" })).perPage, 100);
});

Deno.test("property: parsePagination 随机输入收敛到合法范围或抛 ValidationError", () => {
  const SEED = 20260909;
  const rand = mulberry32(SEED);
  console.log(`  属性测试随机种子: ${SEED}`);
  for (let i = 0; i < 1000; i++) {
    const page = Math.floor(rand() * 1000) - 500;
    const pageSize = Math.floor(rand() * 1000) - 500;
    const ctx = makeCtx({
      page: String(page),
      per_page: String(pageSize),
    });
    try {
      const result = parsePagination(ctx);
      assertEquals(result.page >= 1, true);
      assertEquals(result.perPage >= 1, true);
      assertEquals(result.perPage <= 100, true);
    } catch (err) {
      // 非法输入应抛 ValidationError，而不是其他异常
      assertEquals((err as Error).name, "ValidationError");
    }
  }
});
