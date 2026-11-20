/**
 * 测试数据库 bootstrap 校验。
 *
 * P2b 起迁移与模板种子由测试启动器完成，本文件不再执行 DDL 或 测试数据库 引导；
 * 只验证当前进程确实指向启动器拥有的测试数据库，且正式迁移已建立基础表。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../src/shared/db/connection.ts";
import { unwrapRows } from "../src/shared/base/sql-rows.ts";
import { assertOwnedTestDatabase } from "./helpers/db.ts";

const databaseName = await assertOwnedTestDatabase();
console.log(`[setup] 测试数据库 ${databaseName} 由启动器接管`);

const result = await getDb().execute(
  sql`SELECT to_regclass('users') AS users_table`,
);
const rows = unwrapRows<{ users_table: string | null }>(result as never);
assert(
  rows[0]?.users_table !== null,
  "users 表不存在：测试启动器未执行正式迁移",
);

Deno.test("00_migrate: 测试数据库由启动器完成迁移", () => {
  assertEquals(typeof databaseName, "string");
});
