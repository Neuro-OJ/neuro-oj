import { Hono } from "hono";
import { checkDbHealth } from "./../shared/db/connection.ts";
import { checkRedisHealth } from "./../shared/mq/connection.ts";
import { consumerAlive } from "../domains/submission/index.ts";

const health = new Hono();

interface DependencyHealth {
  database: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
  consumer: { ok: boolean };
}

async function dependencyHealth(): Promise<DependencyHealth> {
  const [database, redis] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);
  return { database, redis, consumer: { ok: consumerAlive.value } };
}

function publicDependencyHealth(
  dependencies: DependencyHealth,
  showDetails: boolean,
) {
  return {
    database: dependencies.database.ok ? "ok" : "error",
    redis: dependencies.redis.ok ? "ok" : "error",
    consumer: dependencies.consumer.ok ? "ok" : "error",
    checks: {
      database: showDetails
        ? dependencies.database
        : { ok: dependencies.database.ok },
      redis: showDetails ? dependencies.redis : { ok: dependencies.redis.ok },
      consumer: dependencies.consumer,
    },
  };
}

/** 存活探针：只验证进程仍能处理 HTTP 请求，不检查外部依赖。 */
health.get("/health/live", (c) =>
  c.json({
    status: "alive",
    service: "noj-core",
    version: "0.1.0",
  }));

/** 就绪探针：依赖不完整时返回 503，供负载均衡器停止导入新流量。 */
health.get("/health/ready", async (c) => {
  const dependencies = await dependencyHealth();
  const ready = dependencies.database.ok && dependencies.redis.ok &&
    dependencies.consumer.ok;
  const showDetails = Deno.env.get("NOJ_ENV") !== "production";
  return c.json({
    status: ready ? "ready" : "not_ready",
    service: "noj-core",
    version: "0.1.0",
    ...publicDependencyHealth(dependencies, showDetails),
  }, ready ? 200 : 503);
});

/** 兼容旧版综合健康端点：保持原有 200 + healthy/degraded 语义。 */
health.get("/health", async (c) => {
  const dependencies = await dependencyHealth();
  const healthy = dependencies.database.ok && dependencies.redis.ok &&
    dependencies.consumer.ok;
  const showDetails = Deno.env.get("NOJ_ENV") !== "production";
  return c.json({
    status: healthy ? "healthy" : "degraded",
    service: "noj-core",
    version: "0.1.0",
    ...publicDependencyHealth(dependencies, showDetails),
  });
});

export default health;
