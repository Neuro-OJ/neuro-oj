import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "./connection.ts";
import { dirname, resolve } from "jsr:@std/path@^1";

const __dirname = dirname(new URL(import.meta.url).pathname);

/**
 * 在启动时执行数据库迁移。
 * 使用 Drizzle ORM 内置的 migrator 读取 drizzle/ 目录下的 SQL 迁移文件，
 * 按文件名排序执行。
 */
export async function runMigrations(): Promise<void> {
  try {
    const db = getDb();

    // 基于 import.meta.url 解析绝对路径，避免 CWD 依赖
    const migrationsFolder = resolve(__dirname, "../../drizzle");
    console.log("迁移文件夹路径:", migrationsFolder);
    await migrate(db, { migrationsFolder });
    console.log("数据库迁移完成");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("数据库迁移失败:", message);
    throw err;
  }
}
