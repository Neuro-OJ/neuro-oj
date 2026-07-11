/**
 * 测试数据库 Schema 引导工具。
 *
 * 在 PGlite 模式下执行 DDL 建表、种子数据插入。
 * 在 postgres.js（DATABASE_URL）模式下全部为 no-op。
 *
 * 注：schema 自动引导已内置在 connection.ts 的 resetDbForTest() 中，
 * 此文件为显式引导入口（用于 00_migrate_test.ts 等需要明确可见 bootstrap 的场景）。
 */

import { getDb } from "../src/db/connection.ts";

/**
 * 判断当前是否为 PGlite 模式（DATABASE_URL 未设置）。
 */
function isPGliteMode(): boolean {
  return !Deno.env.get("DATABASE_URL");
}

/**
 * 执行 DDL 建表，并插入必需种子数据。
 *
 * PGlite 模式下：执行所有 DDL + 索引 + root 用户 + judge_images 种子。
 * postgres.js 模式下：no-op（由 00_migrate_test.ts 使用文件迁移）。
 *
 * 幂等——使用 IF NOT EXISTS / ON CONFLICT DO NOTHING。
 *
 * 注：单条 DDL 失败（如 PGlite 不可用的 pg_trgm 扩展）不影响其他 DDL；
 * 测试驱动不要求扩展可用，仅生产 PG 才走完整 GIN trigram 索引路径。
 */
export async function setupSchemaForTest(): Promise<void> {
  if (!isPGliteMode()) return;

  const db = getDb();

  const { SCHEMA_DDL, SCHEMA_INDEXES } = await import(
    "../src/db/schema-ddl.ts"
  );

  for (const ddl of SCHEMA_DDL) {
    try {
      await db.execute(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[schema-ddl] 跳过: ${msg.slice(0, 120)}`);
    }
  }
  for (const idx of SCHEMA_INDEXES) {
    try {
      await db.execute(idx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[schema-index] 跳过: ${msg.slice(0, 120)}`);
    }
  }

  // 种子数据
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO users (id, username, email, password_hash, role, bio, created_at, updated_at)
     VALUES ('0', 'root', 'root@noj.local', '', 'admin', '', '${now}', '${now}')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
     VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
     ON CONFLICT (id) DO NOTHING`,
  );
}
