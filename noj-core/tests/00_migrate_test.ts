/**
 * 数据库迁移 + 必需种子数据初始化。
 * 文件名以 00 开头，确保在其它测试之前按字母序最先执行。
 * 仅在 DATABASE_URL 可用时执行迁移。
 */
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/db/migrate.ts";
import { ensureRootUser } from "../src/services/auth.ts";
import { getDb } from "../src/db/connection.ts";
import { judgeImages } from "../src/db/schema.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");

if (hasDb) {
  console.log("[setup] 开始数据库迁移...");
  try {
    await runMigrations();
    console.log("[setup] 数据库迁移完成");

    // 创建 root 系统用户（UID=0）作为必需种子数据
    // problems.owner_id 的 FK 约束依赖该用户存在
    await ensureRootUser();
    console.log("[setup] Root 用户就绪");

    // 插入默认评测镜像白名单，确保 services/problems 等测试中的
    // validateJudgeImage() 校验通过。幂等：按 image 名查询，不存在才插入。
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
  console.log("[setup] 跳过迁移（DATABASE_URL 未设置）");
}
