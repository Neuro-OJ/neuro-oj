import { Hono } from "hono";
import { checkDbHealth } from "../db/connection.ts";
import { checkRedisHealth } from "../mq/connection.ts";

const health = new Hono();

/**
 * 健康检查端点。
 * 返回服务状态及依赖组件（数据库、Redis）的连接状态。
 */
health.get("/health", async (c) => {
  const db = await checkDbHealth();
  const redis = checkRedisHealth();

  // 生产环境隐藏错误详情，防止泄露内部信息
  const showDetails = Deno.env.get("NOJ_ENV") !== "production";

  return c.json({
    status: "ok",
    service: "noj-core",
    version: "0.1.0",
    database: db.ok ? "ok" : "error",
    redis: redis.ok ? "ok" : "error",
    checks: {
      database: showDetails ? db : { ok: db.ok },
      redis: showDetails ? redis : { ok: redis.ok },
    },
  });
});

export default health;
