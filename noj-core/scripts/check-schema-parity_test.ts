/**
 * schema-ddl parity 门禁的自测（2026-09-12 架构评审 §3.3）。
 *
 * 门禁自身的解析器也必须被测：实测中发现"列注释与列被同一段逗号切分吞掉"
 * 会制造假信号（audit_logs.admin_id 被误报缺失），因此下面覆盖注释、约束行、
 * 名为 `key` 的列、CHECK 内的逗号等易错形态。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkSchemaParity,
  compareSchemas,
  drizzleTables,
  parseDdlTables,
} from "./check-schema-parity.ts";
import * as schema from "../src/shared/db/schema.ts";

Deno.test("schema-parity: 解析带引号/不带引号的表名与列", () => {
  const tables = parseDdlTables([
    `CREATE TABLE IF NOT EXISTS "users" (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    );`,
    `CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );`,
  ]);
  assertEquals([...tables.keys()].sort(), ["roles", "users"]);
  assertEquals([...tables.get("users")!], ["id", "email"]);
});

Deno.test("schema-parity: 约束行被跳过，CHECK 内逗号不切分", () => {
  const tables = parseDdlTables([
    `CREATE TABLE IF NOT EXISTS t (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('a', 'b')),
      CONSTRAINT t_status_check CHECK (status <> ''),
      UNIQUE (id),
      FOREIGN KEY (id) REFERENCES other(id)
    );`,
  ]);
  assertEquals([...tables.get("t")!], ["id", "status"]);
});

Deno.test("schema-parity: 名为 key 的列不被当成约束关键字", () => {
  const tables = parseDdlTables([
    `CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`,
  ]);
  assertEquals([...tables.get("system_settings")!], ["key", "value"]);
});

Deno.test("schema-parity: 列注释不吞掉紧随其后的列", () => {
  const tables = parseDdlTables([
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      -- PR-2：admin_id 改为 nullable，auth.* 事件可能无 actor（登录失败等）
      admin_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL
    );`,
  ]);
  assertEquals([...tables.get("audit_logs")!], [
    "id",
    "admin_id",
    "created_at",
  ]);
});

Deno.test("schema-parity: 表/列的增删都能被发现", () => {
  const drizzle = new Map([
    ["a", new Set(["id", "x"])],
    ["b", new Set(["id"])],
  ]);
  const ddl = new Map([
    ["a", new Set(["id", "y"])],
    ["c", new Set(["id"])],
  ]);
  const errors = compareSchemas(drizzle, ddl);
  assert(errors.some((e) => e.includes("缺少表: b")), JSON.stringify(errors));
  assert(errors.some((e) => e.includes("多出表: c")), JSON.stringify(errors));
  assert(errors.some((e) => e.includes("缺少列: x")), JSON.stringify(errors));
  assert(errors.some((e) => e.includes("多出列: y")), JSON.stringify(errors));
});

Deno.test("schema-parity: Drizzle 侧能解析出全部表", () => {
  const tables = drizzleTables(schema as unknown as Record<string, unknown>);
  assert(
    tables.size >= 50,
    `Drizzle 表数异常偏少（${tables.size}），解析方式可能已失效`,
  );
  // 抽查几个关键表的列
  assert(tables.get("users")?.has("id"), "users.id 应存在");
  assert(
    !tables.get("roles")?.has("is_admin"),
    "roles.is_admin 已被迁移 0032 删除",
  );
});

Deno.test("schema-parity: 真实仓库两侧一致", () => {
  const { errors, stats } = checkSchemaParity();
  assertEquals(errors, []);
  assertEquals(stats.drizzle_tables, stats.ddl_tables);
  assert(
    stats.compared_columns > 300,
    `比对列数异常偏少：${stats.compared_columns}`,
  );
});
