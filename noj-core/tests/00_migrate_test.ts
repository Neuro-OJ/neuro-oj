/**
 * 数据库迁移初始化。
 * 文件名以 00 开头，确保在其它测试之前按字母序最先执行。
 * 仅在 DATABASE_URL 可用时执行迁移。
 */
import { runMigrations } from "../src/db/migrate.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");

if (hasDb) {
  console.log("[setup] 开始数据库迁移...");
  try {
    await runMigrations();
    console.log("[setup] 数据库迁移完成");
  } catch (err) {
    console.error("[setup] 数据库迁移失败:", err);
    Deno.exit(1);
  }
} else {
  console.log("[setup] 跳过迁移（DATABASE_URL 未设置）");
}
