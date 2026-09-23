/**
 * `buildConnectionOptions` 单测。
 *
 * 背景：中文 2 字短查询会退化为全表扫描，PG 判为高代价并触发 JIT 编译
 * （实测 10 万行搜索中 JIT 编译占 238ms 纯开销）。连接层默认发送 `-cjit=off`。
 * 本测试锁定 startup 参数拼接，避免 JIT 关闭/测试分片 search_path 静默漂移。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { buildConnectionOptions } from "../../../src/shared/db/connection.ts";

Deno.test("buildConnectionOptions: 默认关闭 JIT", () => {
  assertEquals(buildConnectionOptions("", true), { options: "-cjit=off" });
});

Deno.test("buildConnectionOptions: DATABASE_JIT=on 时不注入 jit 参数", () => {
  assertEquals(buildConnectionOptions("", false), undefined);
});

Deno.test("buildConnectionOptions: 测试分片附带 public 并关闭 JIT", () => {
  assertEquals(buildConnectionOptions("test_db", true), {
    options: "-csearch_path=test_db,public -cjit=off",
  });
});

Deno.test("buildConnectionOptions: 仅分片、JIT 开启时不注入 jit", () => {
  assertEquals(buildConnectionOptions("test_unit", false), {
    options: "-csearch_path=test_unit,public",
  });
});
