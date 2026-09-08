/**
 * test-parallel 分片参数解析测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parseShardArgs } from "../../scripts/test-parallel-args.ts";

Deno.test("test-parallel: 默认分片为 2", () => {
  assertEquals(parseShardArgs([]), 2);
});

Deno.test("test-parallel: 解析 --shards 4", () => {
  assertEquals(parseShardArgs(["--shards", "4"]), 4);
});

Deno.test("test-parallel: 非法分片数回退默认", () => {
  assertEquals(parseShardArgs(["--shards", "abc"]), 2);
});
