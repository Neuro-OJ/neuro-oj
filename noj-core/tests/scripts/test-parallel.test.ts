/**
 * test-parallel 分片参数解析测试。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { parseShardArgs } from "../../scripts/test-parallel-args.ts";

Deno.test("test-parallel: 默认分片为内置分片数", () => {
  assertEquals(parseShardArgs([]), 2);
  assertEquals(parseShardArgs([], 3), 3);
});

Deno.test("test-parallel: 解析 --shards 1", () => {
  assertEquals(parseShardArgs(["--shards", "1"]), 1);
});

Deno.test("test-parallel: --shards 超过内置分片数时报错", () => {
  assertThrows(
    () => parseShardArgs(["--shards", "4"], 2),
    Error,
    "超过内置分片数",
  );
});

Deno.test("test-parallel: 非法分片数报错", () => {
  assertThrows(() => parseShardArgs(["--shards", "abc"]), Error, "≥1 的整数");
  assertThrows(() => parseShardArgs(["--shards", "0"]), Error, "≥1 的整数");
});
