import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";

const __dirname = dirname(fromFileUrl(import.meta.url));

/**
 * 解析与生产迁移器相同的发布集迁移目录。
 *
 * 单独成模块是为了打断 `migrate.ts` ↔ `migration-switch.ts` ↔
 * `schema-compat.ts` 的运行时环：三处都要读同一个目录，但只有迁移器需要执行迁移。
 */
export function resolveMigrationsDirectory(): string {
  return Deno.env.get("NOJ_MIGRATIONS_DIR") ??
    resolve(__dirname, "../../../drizzle");
}
