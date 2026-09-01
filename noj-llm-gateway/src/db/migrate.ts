import postgres from "postgres";
import { dirname, resolve } from "jsr:@std/path@^1";

/**
 * 执行 noj-llm-gateway 自己的 SQL 迁移。
 *
 * 使用独立的 llm_schema_migrations 表记录已应用文件，避免与 noj-core
 * 的 Drizzle 迁移记录互相干扰。基线迁移使用 IF NOT EXISTS，老库可安全执行。
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS llm_schema_migrations (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at text NOT NULL
      )
    `;

    const dir = resolve(
      dirname(new URL(import.meta.url).pathname),
      "../../drizzle",
    );
    const files: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
    }
    files.sort();

    for (const file of files) {
      const applied = await sql`
        SELECT 1 FROM llm_schema_migrations WHERE name = ${file}
      `;
      if (applied.length > 0) continue;

      const content = await Deno.readTextFile(resolve(dir, file));
      await sql.unsafe(content);
      await sql`
        INSERT INTO llm_schema_migrations (name, applied_at)
        VALUES (${file}, ${new Date().toISOString()})
      `;
      console.log(`[llm-gateway] 已应用迁移: ${file}`);
    }
  } finally {
    await sql.end();
  }
}
