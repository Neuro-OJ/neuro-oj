import { loadConfig } from "../config.ts";
import { runMigrations } from "./migrate.ts";

const config = loadConfig();
await runMigrations(config.databaseUrl);
console.log("LLM gateway 迁移完成");
