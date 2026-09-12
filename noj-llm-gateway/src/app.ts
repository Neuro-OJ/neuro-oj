/**
 * noj-llm-gateway Hono 应用工厂。
 */
import { Hono } from "hono";
import type { GatewayConfig } from "./config.ts";
import { requestIdMiddleware } from "./context.ts";
import { createDb } from "./db.ts";
import { createRedis } from "./redis.ts";
import { createLlmRouter } from "./routes/llm.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { renderMetrics } from "./metrics.ts";

/** 创建 Hono 应用；DB/Redis 可用时挂载代理与内部管理路由。 */
export function createApp(config: GatewayConfig) {
  const app = new Hono();

  // 请求上下文最先挂载：使后续所有路由/服务的日志自动带上同一 request_id。
  app.use("*", requestIdMiddleware());

  const db = config.databaseUrl ? createDb(config.databaseUrl) : null;
  const redis = config.redisUrl ? createRedis(config.redisUrl) : null;

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "noj-llm-gateway",
      time: new Date().toISOString(),
    });
  });

  app.get("/health/live", (c) => {
    return c.json({
      status: "alive",
      service: "noj-llm-gateway",
      contract_version: 1,
      time: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (c) => {
    if (!db || !redis) {
      return c.json({
        status: "not_ready",
        service: "noj-llm-gateway",
        detail: "database or redis not configured",
      }, 503);
    }
    try {
      await redis.ping();
      return c.json({ status: "ready", service: "noj-llm-gateway" });
    } catch {
      return c.json({ status: "not_ready", service: "noj-llm-gateway" }, 503);
    }
  });

  app.get("/metrics", (c) => {
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(renderMetrics());
  });

  if (db && redis) {
    app.route("/", createLlmRouter({ config, db, redis }));
    app.route("/", createInternalRouter({ config, db }));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
