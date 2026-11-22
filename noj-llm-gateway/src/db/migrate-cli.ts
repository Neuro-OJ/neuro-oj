import { loadConfig } from "../config.ts";
import { logger, setupGatewayLogging } from "../logger.ts";
import { runMigrations } from "./migrate.ts";
import { createDb } from "../db.ts";
import { seedDefaultQuotas } from "./seed.ts";

const USAGE = [
    "用法: deno task db:migrate [--schema-only]",
    "",
    "  --schema-only  只执行 Gateway DDL 迁移，不写入默认配额种子；",
    "                 用于 v0.10.6 → v0.11 逻辑升级前初始化必须保持为空的目标库",
].join("\n");

export interface GatewayMigrateCliOptions {
    schemaOnly: boolean;
}

/** 解析显式迁移入口参数；未知参数直接拒绝，避免拼写错误被静默当成完整初始化。 */
export function parseGatewayMigrateArgs(
    argv: readonly string[],
): GatewayMigrateCliOptions {
    let schemaOnly = false;
    for (const arg of argv) {
        if (arg === "--schema-only") {
            schemaOnly = true;
            continue;
        }
        throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
    return { schemaOnly };
}

if (import.meta.main) {
    // 独立 CLI 入口不会经过 main.ts，需自行装配日志（幂等）。
    setupGatewayLogging();

    const options = parseGatewayMigrateArgs(Deno.args);
    const config = loadConfig();
    await runMigrations(config.databaseUrl);
    if (options.schemaOnly) {
        logger.info("LLM gateway 迁移完成（--schema-only：未写入默认配额）");
    } else {
        const db = createDb(config.databaseUrl);
        try {
            await seedDefaultQuotas(db);
        } finally {
            await db.end();
        }
        logger.info("LLM gateway 迁移与默认配额初始化完成");
    }
}
