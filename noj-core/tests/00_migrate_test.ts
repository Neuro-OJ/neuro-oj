/**
 * 数据库初始化 + 必需种子数据。
 * 文件名以 00 开头，确保在其它测试之前按字母序最先执行。
 *
 * 双模式：
 * - DATABASE_URL 已设置 → 使用 drizzle-orm/postgres-js/migrator 执行文件迁移
 * - DATABASE_URL 未设置 → 使用 PGlite 内存数据库，执行 DDL SQL 建表
 */
import { runMigrations } from "../src/db/migrate.ts";
import { ensureRootUser } from "../src/services/auth.ts";
import { getDb } from "../src/db/connection.ts";
import { setupSchemaForTest } from "./_setup.ts";
import { judgeImages } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");

if (hasDb) {
  // postgres.js 模式：原有文件迁移路径
  console.log("[setup] 开始数据库迁移...");
  try {
    await runMigrations();
    console.log("[setup] 数据库迁移完成");

    await ensureRootUser();
    console.log("[setup] Root 用户就绪");

    const db = getDb();
    const now = new Date().toISOString();
    const existing = await db
      .select()
      .from(judgeImages)
      .where(eq(judgeImages.image, "noj-judge-python"))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(judgeImages).values({
        id: "e0000000-0000-0000-0000-000000000001",
        image: "noj-judge-python",
        mode: "all_versions",
        description: "Python 3.12 评测环境",
        created_at: now,
        updated_at: now,
      });
      console.log("[setup] 默认评测镜像白名单就绪");
    } else {
      console.log("[setup] 默认评测镜像已存在，跳过插入");
    }
  } catch (err) {
    console.error("[setup] 数据库/种子数据初始化失败:", err);
    Deno.exit(1);
  }
} else {
  // PGlite 模式：DDL SQL 引导
  console.log("[setup] PGlite 模式：正在初始化 Schema...");
  try {
    await setupSchemaForTest();
    console.log("[setup] PGlite Schema 和种子数据就绪");
  } catch (err) {
    console.error("[setup] PGlite 初始化失败:", err);
    Deno.exit(1);
  }
}
