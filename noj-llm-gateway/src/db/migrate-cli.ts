import { loadConfig } from "../config.ts";
import { logger, setupGatewayLogging } from "../logger.ts";
import { runMigrations } from "./migrate.ts";
import { createDb } from "../db.ts";
import { seedDefaultQuotas } from "./seed.ts";

// 独立 CLI 入口不会经过 main.ts，需自行装配日志（幂等）。
setupGatewayLogging();

const config = loadConfig();
await runMigrations(config.databaseUrl);
const db = createDb(config.databaseUrl);
try {
  await seedDefaultQuotas(db);
} finally {
  await db.end();
}
logger.info("LLM gateway 迁移与默认配额初始化完成");
