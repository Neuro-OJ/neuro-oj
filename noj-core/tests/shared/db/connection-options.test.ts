/**
 * `buildConnectionOptions` 单测。
 *
 * 背景：中文 2 字短查询会退化为全表扫描，PG 判为高代价并触发 JIT 编译
 * （实测 10 万行搜索中 JIT 编译占 238ms 纯开销）。连接层默认发送 `-cjit=off`。
 * 测试使用独立数据库隔离，不再向生产连接注入测试 schema。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { buildConnectionOptions } from "../../../src/shared/db/options.ts";

Deno.test("buildConnectionOptions: 默认关闭 JIT", () => {
  assertEquals(buildConnectionOptions(true), { options: "-cjit=off" });
});

Deno.test("buildConnectionOptions: DATABASE_JIT=on 时不注入 jit 参数", () => {
  assertEquals(buildConnectionOptions(false), undefined);
});
