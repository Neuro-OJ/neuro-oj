/**
 * noj-llm-gateway Hono 应用工厂。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { GatewayConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { createRedis } from "./redis.ts";
import { createLlmRouter } from "./routes/llm.ts";
import { createInternalRouter } from "./routes/internal.ts";

export function createApp(config: GatewayConfig) {
  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "noj-llm-gateway",
      time: new Date().toISOString(),
    });
  });

  const db = config.databaseUrl ? createDb(config.databaseUrl) : null;
  const redis = config.redisUrl ? createRedis(config.redisUrl) : null;

  if (db && redis) {
    app.route("/", createLlmRouter({ config, db, redis }));
    app.route("/", createInternalRouter({ config, db }));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
