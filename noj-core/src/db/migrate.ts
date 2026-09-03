import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "./connection.ts";
import { dirname, resolve } from "jsr:@std/path@^1";
import { logger } from "./../shared/base/logging.ts";

const __dirname = dirname(new URL(import.meta.url).pathname);

/**
 * 在启动时执行数据库迁移。
 * 使用 Drizzle ORM 内置的 migrator 读取 drizzle/ 目录下的 SQL 迁移文件，
 * 按文件名排序执行。
 *
 * TEST_SCHEMA 分片模式：migrator 默认把迁移记录表（__drizzle_migrations）
 * 建在固定的 `drizzle` schema，各分片共享同一份记录会导致"已迁移"误判
 * 跳过（并行分片建表失败的根因）。设置 migrationsSchema 为 TEST_SCHEMA
 * 后，迁移记录表与业务表落在同一 schema，分片之间完全隔离。
 */
export async function runMigrations(): Promise<void> {
  try {
    const db = getDb();

    // 基于 import.meta.url 解析绝对路径，避免 CWD 依赖；
    // deno compile 后 import.meta.url 指向二进制路径，生产镜像通过
    // NOJ_MIGRATIONS_DIR 显式指定迁移目录。
    const migrationsFolder = Deno.env.get("NOJ_MIGRATIONS_DIR") ??
      resolve(__dirname, "../../drizzle");
    const migrationsSchema = Deno.env.get("TEST_SCHEMA") || undefined;
    logger.info("开始数据库迁移", {
      migrations_folder: migrationsFolder,
      migrations_schema: migrationsSchema ?? "drizzle",
    });
    await migrate(db, {
      migrationsFolder,
      ...(migrationsSchema ? { migrationsSchema } : {}),
    });
    logger.info("数据库迁移完成");
  } catch (err) {
    logger.error("数据库迁移失败", { err });
    throw err;
  }
}
