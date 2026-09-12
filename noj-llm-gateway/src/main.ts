/**
 * noj-llm-gateway 入口。
 */
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { createDb } from "./db.ts";
import { seedDefaultQuotas } from "./db/seed.ts";
import { setupGatewayLogging } from "./logger.ts";

// 尽早装配日志：先于任何可能失败的启动步骤（迁移/种子），
// 否则这些步骤失败时没有任何结构化输出可供排查。
setupGatewayLogging();

const config = loadConfig();

await runMigrations(config.databaseUrl);

const seedDb = createDb(config.databaseUrl);
await seedDefaultQuotas(seedDb);
await seedDb.end();

const app = createApp(config);

Deno.serve({ port: config.port }, app.fetch);
