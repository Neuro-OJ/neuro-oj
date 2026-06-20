/**
 * 测试全局设置。
 * 在运行所有测试前执行数据库迁移（仅当 DATABASE_URL 可用时）。
 */
import { runMigrations } from "../src/db/migrate.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");

if (hasDb) {
  try {
    await runMigrations();
    console.log("测试环境数据库迁移完成");
  } catch (err) {
    console.error("测试环境数据库迁移失败:", err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
