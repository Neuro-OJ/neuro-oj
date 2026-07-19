import { assertEquals } from "jsr:@std/assert@^1";
import {
  countToNumber,
  unwrapFirstRow,
  unwrapRows,
} from "../../src/lib/sql-rows.ts";

Deno.test({
  name: "sql-rows: unwrapRows 处理 postgres.js array-like 形态",
  fn: () => {
    const arr = [{ id: "1" }, { id: "2" }];
    const result = unwrapRows<{ id: string }>(arr);
    assertEquals(result.length, 2);
    assertEquals(result[0].id, "1");
  },
});

Deno.test({
  name: "sql-rows: unwrapRows 处理 PGlite { rows: [...] } 形态",
  fn: () => {
    const pgliteResult = { rows: [{ id: "a" }, { id: "b" }] };
    const result = unwrapRows<{ id: string }>(
      pgliteResult as unknown as { rows: { id: string }[] },
    );
    assertEquals(result.length, 2);
    assertEquals(result[1].id, "b");
  },
});

Deno.test({
  name: "sql-rows: unwrapRows 防御性 fallback（未知形态 → 空数组）",
  fn: () => {
    // 异常输入不应抛错，应返回空数组让调用方按 0 行处理
    const result = unwrapRows<unknown>(
      "garbage" as unknown as unknown[],
    );
    assertEquals(result.length, 0);
  },
});

Deno.test({
  name: "sql-rows: unwrapFirstRow 取首行",
  fn: () => {
    const arr = [{ id: "first" }, { id: "second" }];
    const first = unwrapFirstRow<{ id: string }>(arr);
    assertEquals(first?.id, "first");
  },
});

Deno.test({
  name: "sql-rows: unwrapFirstRow 空数组返回 undefined",
  fn: () => {
    const first = unwrapFirstRow<{ id: string }>([]);
    assertEquals(first, undefined);
  },
});

Deno.test({
  name: "sql-rows: countToNumber 统一 number / string",
  fn: () => {
    assertEquals(countToNumber(42), 42);
    assertEquals(countToNumber("42"), 42);
    assertEquals(countToNumber("abc"), 0);
    assertEquals(countToNumber(null), 0);
    assertEquals(countToNumber(undefined), 0);
  },
});
