import { Hono } from "hono";
import { checkDbHealth } from "./../shared/db/connection.ts";
import { checkRedisHealth } from "./../shared/mq/connection.ts";
import { consumerAlive, getQueueHealth } from "../domains/submission/index.ts";

const health = new Hono();

interface DependencyHealth {
  database: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
  consumer: { ok: boolean };
  queue: {
    ok: boolean;
    redis_ok: boolean;
    judge: {
      queue_length: number;
      processing_length: number;
      dead_length: number;
    };
    result: {
      queue_length: number;
      processing_length: number;
      dead_length: number;
    };
  };
}

async function dependencyHealth(): Promise<DependencyHealth> {
  const [database, redis, queue] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
    getQueueHealth(),
  ]);
  // 队列状态只作为可观测字段，不参与 ready/healthy 判定。
  const queueOk = queue.redis_ok &&
    queue.judge.queue_length >= 0 &&
    queue.result.queue_length >= 0;
  return {
    database,
    redis,
    consumer: { ok: consumerAlive.value },
    queue: {
      ok: queueOk,
      redis_ok: queue.redis_ok,
      judge: queue.judge,
      result: queue.result,
    },
  };
}

function publicDependencyHealth(
  dependencies: DependencyHealth,
  showDetails: boolean,
) {
  return {
    database: dependencies.database.ok ? "ok" : "error",
    redis: dependencies.redis.ok ? "ok" : "error",
    consumer: dependencies.consumer.ok ? "ok" : "error",
    queue: dependencies.queue.ok ? "ok" : "error",
    checks: {
      database: showDetails
        ? dependencies.database
        : { ok: dependencies.database.ok },
      redis: showDetails ? dependencies.redis : { ok: dependencies.redis.ok },
      consumer: dependencies.consumer,
      queue: showDetails
        ? {
          ok: dependencies.queue.ok,
          redis_ok: dependencies.queue.redis_ok,
          judge: dependencies.queue.judge,
          result: dependencies.queue.result,
        }
        : { ok: dependencies.queue.ok },
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
