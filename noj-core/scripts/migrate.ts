/**
 * 迁移脚本入口。
 * 在启动服务前执行数据库迁移。
 * 可在 CI 或开发环境中独立使用。
 *
 * 用法：deno run -A scripts/migrate.ts
 */
import { closeDbForShutdown } from "./../src/shared/db/connection.ts";
import { runMigrations } from "./../src/shared/db/migrate.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error("[migrate] DATABASE_URL 未设置，拒绝跳过迁移");
  Deno.exit(1);
}

console.log("[migrate] DATABASE_URL 已设置");
console.log("[migrate] 开始执行数据库迁移...");
const start = performance.now();
let exitCode = 0;
try {
  await runMigrations();
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[migrate] 迁移完成 (${elapsed}ms)`);
} catch (err) {
  exitCode = 1;
  console.error("[migrate] 迁移失败:", err);
} finally {
  try {
    await closeDbForShutdown();
  } catch (error) {
    exitCode = 1;
    console.error(
      `[migrate] 数据库连接清理失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

Deno.exit(exitCode);
