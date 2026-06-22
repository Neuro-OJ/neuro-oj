import { Hono } from "hono";
import { checkDbHealth } from "../db/connection.ts";
import { checkRedisHealth } from "../mq/connection.ts";
import { consumerAlive } from "../mq/consumer.ts";

const health = new Hono();

/**
 * 健康检查端点。
 * 返回服务状态及依赖组件（数据库、Redis、结果消费者）的连接状态。
 * 所有组件正常时返回 healthy，部分异常时返回 degraded。
 */
health.get("/health", async (c) => {
  const [db, redis] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);

  const consumerOk = consumerAlive;
  const allOk = db.ok && redis.ok && consumerOk;

  // 生产环境隐藏错误详情，防止泄露内部信息
  const showDetails = Deno.env.get("NOJ_ENV") !== "production";

  return c.json({
    status: allOk ? "healthy" : "degraded",
    service: "noj-core",
    version: "0.1.0",
    database: db.ok ? "ok" : "error",
    redis: redis.ok ? "ok" : "error",
    consumer: consumerOk ? "ok" : "error",
    checks: {
      database: showDetails ? db : { ok: db.ok },
      redis: showDetails ? redis : { ok: redis.ok },
      consumer: { ok: consumerOk },
    },
  });
});

export default health;
