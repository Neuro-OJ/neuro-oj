/**
 * 健康探针路由。
 *
 * - /health/live：进程存活，不检查外部依赖。
 * - /health/ready：critical 探针全部 up 才 200，否则 503。
 * - /health：兼容旧综合健康端点，始终 200 + healthy/degraded。
 */

import { Hono } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { runHealthProbes } from "../probes/registry.ts";

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
    const results = await runHealthProbes(registry);
    const critical = results.filter((r) => criticalNames.has(r.name));
    const healthy = critical.every((r) => r.status === "up");
    const showDetails = Deno.env.get("NOJ_ENV") !== "production";
    return c.json({
      status: healthy ? "healthy" : "degraded",
      service: "noj-core",
      version: "0.1.0",
      checks: showDetails
        ? Object.fromEntries(results.map((r) => [r.name, r]))
        : undefined,
    });
  });

  return health;
}
