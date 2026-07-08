/**
 * 迁移脚本入口。
 * 在启动服务前执行数据库迁移。
 * 可在 CI 或开发环境中独立使用。
 *
 * 用法：deno run -A scripts/migrate.ts
 */
import { runMigrations } from "../src/db/migrate.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDb = !!databaseUrl;
console.log(
  `[migrate] DATABASE_URL ${hasDb ? "已设置" : "未设置（跳过迁移）"}`,
);

if (hasDb) {
  console.log("[migrate] 开始执行数据库迁移...");
  console.log(
    `[migrate] 数据库连接: ${(databaseUrl ?? "").replace(/\/\/.*@/, "//***@")}`,
  );
  const start = performance.now();
  try {
    await runMigrations();
    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`[migrate] 迁移完成 (${elapsed}ms)`);

    // 强制退出，避免 postgres.js 连接阻止 Deno 进程终止
    Deno.exit(0);
  } catch (err) {
    console.error("[migrate] 迁移失败:", err);
    Deno.exit(1);
  }
} else {
  console.log("[migrate] 跳过迁移（无数据库配置）");
}
