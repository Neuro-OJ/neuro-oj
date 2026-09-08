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

Deno.test("property: parsePagination 随机输入收敛到合法范围或抛 ValidationError", () => {
  for (let i = 0; i < 1000; i++) {
    const page = Math.floor(Math.random() * 1000) - 500;
    const pageSize = Math.floor(Math.random() * 1000) - 500;
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
