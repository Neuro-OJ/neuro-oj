/**
 * test-parallel 分片/并行度参数解析测试。
 *
 * 语义变更（P5）：`--shards N` 把**全部**所选测试划分成 N 片，不再按内置分片
 * 清单截断——旧实现 `--shards 1` 会漏跑业务分片。`--jobs M` 控制同时运行的
 * 分片数，上限由独立 DB/Redis 资源成本决定。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  parseJobArgs,
  parseShardArgs,
} from "../../scripts/test-parallel-args.ts";
import {
  DEFAULT_JOB_COUNT,
  DEFAULT_SHARD_COUNT,
  MAX_JOB_COUNT,
  MAX_SHARD_COUNT,
} from "../../scripts/test-parallel-shards.ts";

Deno.test("test-parallel: 默认 4 分片 / 2 并发", () => {
  assertEquals(DEFAULT_SHARD_COUNT, 4);
  assertEquals(DEFAULT_JOB_COUNT, 2);
  assertEquals(parseShardArgs([]), DEFAULT_SHARD_COUNT);
  assertEquals(parseJobArgs([]), DEFAULT_JOB_COUNT);
});

Deno.test("test-parallel: --shards 1 合法（全部测试放入一片，不截断）", () => {
  assertEquals(parseShardArgs(["--shards", "1"]), 1);
  assertEquals(parseShardArgs(["--shards", "2"]), 2);
  assertEquals(
    parseShardArgs(["--shards", String(MAX_SHARD_COUNT)]),
    MAX_SHARD_COUNT,
  );
});

Deno.test("test-parallel: --shards 超过上限时报错", () => {
  assertThrows(
    () => parseShardArgs(["--shards", String(MAX_SHARD_COUNT + 1)]),
    Error,
    "超过上限",
  );
});

Deno.test("test-parallel: 非法分片数报错", () => {
  assertThrows(() => parseShardArgs(["--shards", "abc"]), Error, "≥1 的整数");
  assertThrows(() => parseShardArgs(["--shards", "0"]), Error, "≥1 的整数");
  assertThrows(() => parseShardArgs(["--shards", "-1"]), Error, "≥1 的整数");
  assertThrows(() => parseShardArgs(["--shards"]), Error, "缺少数值");
});

Deno.test("test-parallel: --jobs 合法范围与上限校验", () => {
  assertEquals(parseJobArgs(["--jobs", "1"]), 1);
  assertEquals(parseJobArgs(["--jobs", String(MAX_JOB_COUNT)]), MAX_JOB_COUNT);
  assertThrows(
    () => parseJobArgs(["--jobs", String(MAX_JOB_COUNT + 1)]),
    Error,
    "超过上限",
  );
  assertThrows(() => parseJobArgs(["--jobs", "0"]), Error, "≥1 的整数");
  assertThrows(() => parseJobArgs(["--jobs"]), Error, "缺少数值");
});

Deno.test("test-parallel: 自定义上限可被显式传入（便于资源受限环境收紧）", () => {
  assertEquals(parseShardArgs(["--shards", "2"], 2, 1), 2);
  assertThrows(
    () => parseShardArgs(["--shards", "3"], 2, 1),
    Error,
    "超过上限",
  );
  assertEquals(parseJobArgs([], 1, 1), 1);
});
