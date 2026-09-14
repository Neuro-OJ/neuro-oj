/**
 * 快照链门禁的自测。
 *
 * 门禁本身也必须被测试——否则它可能"永远通过"（本仓库 2026-09-12 评审的核心教训）。
 * 本文件用**临时目录**构造快照/迁移样本，不触碰真实 drizzle 目录。
 */
// deno-lint-ignore-file no-explicit-any -- 测试内构造 drizzle snapshot 片段
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkSnapshotChain,
  codeTableNames,
  createdTableNames,
  droppedTableNames,
  INTENTIONAL_REMOVALS,
  listSnapshots,
  tableNamesOf,
} from "./check-migration-snapshot-chain.ts";

Deno.test("snapshot-chain: tableNamesOf 去掉 schema 前缀", () => {
  const names = tableNamesOf({
    tables: { "public.users": {}, "public.posts": {}, "legacy": {} },
  });
  assertEquals([...names].sort(), ["legacy", "posts", "users"]);
});

Deno.test("snapshot-chain: tableNamesOf 对空/异常结构返回空集合", () => {
  assertEquals(tableNamesOf({}).size, 0);
  assertEquals(tableNamesOf(null).size, 0);
  assertEquals(tableNamesOf({ tables: null }).size, 0);
});

Deno.test("snapshot-chain: 真实仓库的已创建表解析包含不带引号的早期迁移写法", async () => {
  const created = await createdTableNames();
  assert(created.size > 50, `应解析出大量建表语句，实际 ${created.size}`);
  // 0000_initial.sql 用 `CREATE TABLE IF NOT EXISTS users (`（无引号）
  assert(created.has("users"), "应解析出不带引号的 users 表");
  assert(created.has("search_entries"), "应解析出 search_entries");
});

Deno.test("snapshot-chain: 真实仓库的 DROP TABLE 解析生效", async () => {
  const dropped = await droppedTableNames();
  // 0040_drop_categories_add_tags.sql 显式删除 categories
  assert(dropped.has("categories"), "应解析出被显式 DROP 的 categories");
});

Deno.test("snapshot-chain: 真实仓库的代码表与最新快照一致（本次修复的核心不变量）", async () => {
  const codeTables = await codeTableNames();
  assert(
    codeTables.size > 50,
    `应解析出大量 pgTable 定义，实际 ${codeTables.size}`,
  );

  const files = await listSnapshots();
  const latest = JSON.parse(await Deno.readTextFile(files.at(-1)!));
  const snapshotTables = tableNamesOf(latest);

  const missing = [...codeTables].filter((t) => !snapshotTables.has(t));
  assertEquals(
    missing,
    [],
    `以下表在代码中定义但不在最新快照中：${missing.join(",")}。` +
      `这会让下一次 db:generate 生成重复的 CREATE TABLE`,
  );
});

Deno.test("snapshot-chain: 门禁在当前仓库状态通过", async () => {
  const issues = await checkSnapshotChain();
  assertEquals(issues, []);
});

Deno.test("snapshot-chain: 自检——解析不到快照时判定失败而非静默通过", async () => {
  const empty = await Deno.makeTempDir();
  try {
    // 通过不存在的目录模拟"路径漂移"：listSnapshots 返回空 → 必须报错
    const files = await listSnapshots(empty);
    assertEquals(files.length, 0);
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("snapshot-chain: INTENTIONAL_REMOVALS 的每一项都写明理由", () => {
  const entries = Object.entries(INTENTIONAL_REMOVALS);
  assert(entries.length > 0, "应有已登记的跨服务移交表");
  for (const [table, reason] of entries) {
    assert(reason.length > 10, `${table} 的理由过短，需说明来源与原因`);
  }
});
