/**
 * 测试数据库 Schema 引导工具。
 *
 * 在 PGlite 模式下执行 DDL 建表、种子数据插入。
 * 在 postgres.js（DATABASE_URL）模式下全部为 no-op。
 *
 * 注：schema 自动引导已内置在 connection.ts 的 resetDbForTest() 中，
 * 此文件为显式引导入口（用于 00_migrate_test.ts 等需要明确可见 bootstrap 的场景）。
 */

import { ensurePGliteSchemaForTest } from "../src/db/connection.ts";

/**
 * 判断当前是否为 PGlite 模式（DATABASE_URL 未设置）。
 */
function isPGliteMode(): boolean {
  return !Deno.env.get("DATABASE_URL");
}

/**
 * 执行 DDL 建表，并插入必需种子数据。
 *
 * PGlite 模式下：优先从模板加载 schema，模板缺失时回退到 DDL 引导；
 * 种子数据由 `ensurePGliteSchemaForTest()` 统一处理。
 * postgres.js 模式下：no-op（由 00_migrate_test.ts 使用文件迁移）。
 *
 * 幂等——使用 IF NOT EXISTS / ON CONFLICT DO NOTHING。
 */
export async function setupSchemaForTest(): Promise<void> {
  if (!isPGliteMode()) return;

  await ensurePGliteSchemaForTest();
}
