/**
 * 迁移脚本入口。
 * 在启动服务前执行数据库迁移。
 * 可在 CI 或开发环境中独立使用。
 *
 * 用法：deno run -A scripts/migrate.ts
 */
import { runMigrations } from "../src/db/migrate.ts";

await runMigrations();
