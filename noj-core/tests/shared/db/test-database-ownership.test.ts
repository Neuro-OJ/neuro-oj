import { assert, assertEquals } from "jsr:@std/assert@^1";
import { isOwnedTestDatabaseName } from "../../../tests/helpers/db.ts";

const prefix = "noj_test_r123456";

Deno.test("测试数据库所有权：只接受当前 run 前缀加 shard 边界", () => {
  assert(isOwnedTestDatabaseName(`${prefix}_unit`, prefix));
  assert(isOwnedTestDatabaseName(`${prefix}_template`, prefix));
  assertEquals(isOwnedTestDatabaseName(`${prefix}x_unit`, prefix), false);
  assertEquals(isOwnedTestDatabaseName(prefix, prefix), false);
  assertEquals(isOwnedTestDatabaseName("postgres", prefix), false);
  assertEquals(isOwnedTestDatabaseName(`${prefix}_unit`, "postgres"), false);
  assertEquals(isOwnedTestDatabaseName(`${prefix}_unit`, ""), false);
});
