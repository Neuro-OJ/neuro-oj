/**
 * 健康探针路由。
 *
 * - /health/live：进程存活，不检查外部依赖。
 * - /health/ready：critical 探针全部 up 才 200，否则 503。
 * - /health：兼容旧综合健康端点，始终 200 + healthy/degraded。
 */

import { Hono } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { collectSnapshot, runHealthProbes } from "../probes/registry.ts";

interface QueueHealthEntry {
  queue_length: number;
  processing_length: number;
  dead_length: number;
}

export function createHealthRouter(registry: ObservabilityRegistry): Hono {
  const health = new Hono();
  const criticalNames = new Set(
    registry.listHealthProbes().filter((p) => p.critical).map((p) => p.name),
  );

  health.get(
    "/health/live",
    (c) => c.json({ status: "alive", service: "noj-core", version: "0.1.0" }),
  );

  health.get("/health/ready", async (c) => {
    const results = await runHealthProbes(registry);
    const critical = results.filter((r) => criticalNames.has(r.name));
    const ready = critical.every((r) => r.status === "up");
    const showDetails = Deno.env.get("NOJ_ENV") !== "production";
    return c.json({
      status: ready ? "ready" : "not_ready",
      service: "noj-core",
      version: "0.1.0",
      checks: showDetails
        ? Object.fromEntries(results.map((r) => [r.name, r]))
        : undefined,
    }, ready ? 200 : 503);
  });

  health.get("/health", async (c) => {
    const [probeResults, partial] = await Promise.all([
      runHealthProbes(registry),
      collectSnapshot(registry),
    ]);
    const dbProbe = probeResults.find((r) => r.name === "database");
    const redisProbe = probeResults.find((r) => r.name === "redis");
    const consumerStatus = (
      partial.dependencies as
        | { result_consumer?: { status?: string } }
        | undefined
    )?.result_consumer?.status ?? "unknown";
    const queueHealth = (
      partial.health as
        | {
          queue?: {
            judge?: QueueHealthEntry;
            result?: QueueHealthEntry;
            redis_ok?: boolean;
          };
        }
        | undefined
    )?.queue;
    const queueOk = queueHealth
      ? queueHealth.redis_ok === true &&
        (queueHealth.judge?.queue_length ?? -1) >= 0 &&
        (queueHealth.result?.queue_length ?? -1) >= 0
      : false;
    const healthy = dbProbe?.status === "up" && redisProbe?.status === "up" &&
      consumerStatus === "up";
    const showDetails = Deno.env.get("NOJ_ENV") !== "production";
    const checks = {
      database: showDetails
        ? { ok: dbProbe?.status === "up", error: dbProbe?.error }
        : { ok: dbProbe?.status === "up" },
      redis: showDetails
        ? { ok: redisProbe?.status === "up", error: redisProbe?.error }
        : { ok: redisProbe?.status === "up" },
      consumer: { ok: consumerStatus === "up" },
      queue: showDetails
        ? {
          ok: queueOk,
          redis_ok: queueHealth?.redis_ok ?? false,
          judge: queueHealth?.judge ?? {
            queue_length: -1,
            processing_length: -1,
            dead_length: -1,
          },
          result: queueHealth?.result ?? {
            queue_length: -1,
            processing_length: -1,
            dead_length: -1,
          },
        }
        : { ok: queueOk },
    };
    return c.json({
      status: healthy ? "healthy" : "degraded",
      service: "noj-core",
      version: "0.1.0",
      database: dbProbe?.status === "up" ? "ok" : "error",
      redis: redisProbe?.status === "up" ? "ok" : "error",
      consumer: consumerStatus === "up" ? "ok" : "error",
      queue: queueOk ? "ok" : "error",
      checks,
    });
  });

  return health;
}
