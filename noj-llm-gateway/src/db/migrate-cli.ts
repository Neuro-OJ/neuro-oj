import { loadConfig } from "../config.ts";
import { logger, setupGatewayLogging } from "../logger.ts";
import { runMigrations } from "./migrate.ts";

// 独立 CLI 入口不会经过 main.ts，需自行装配日志（幂等）。
setupGatewayLogging();

const config = loadConfig();
await runMigrations(config.databaseUrl);
logger.info("LLM gateway 迁移完成");
