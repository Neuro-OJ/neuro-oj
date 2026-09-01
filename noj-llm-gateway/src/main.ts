/**
 * noj-llm-gateway 入口。
 */
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { createDb } from "./db.ts";
import { seedDefaultQuotas } from "./db/seed.ts";

const config = loadConfig();

await runMigrations(config.databaseUrl);

const seedDb = createDb(config.databaseUrl);
await seedDefaultQuotas(seedDb);
await seedDb.end();

const app = createApp(config);

Deno.serve({ port: config.port }, app.fetch);
