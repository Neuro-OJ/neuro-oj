import { Hono } from "hono";

const health = new Hono();

/**
 * 健康检查端点。
 */
health.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "noj-core",
    version: "0.1.0",
  });
});

export default health;
