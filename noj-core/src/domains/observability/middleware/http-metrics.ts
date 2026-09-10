/**
 * HTTP 指标采集中间件。
 */

import type { Context, Next } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { normalizeMetricRoute } from "../../../shared/observability/registry.ts";

export function httpMetricsMiddleware(registry: ObservabilityRegistry) {
  return async function metricsMiddleware(
    c: Context,
    next: Next,
  ): Promise<void> {
    const startedAt = performance.now();
    registry.add("noj_http_requests_in_flight", 1);
    try {
      await next();
    } finally {
      registry.add("noj_http_requests_in_flight", -1);
      const routePath = (c.req as unknown as { routePath?: string }).routePath;
      const route = normalizeMetricRoute(c.req.path, routePath);
      const labels = {
        method: c.req.method,
        route,
        status: String(c.res.status),
      };
      registry.inc("noj_http_requests_total", labels);
      if (c.res.status >= 500) {
        registry.inc("noj_http_request_errors_total", labels);
      }
      registry.observe(
        "noj_http_request_duration_seconds",
        Math.max(0, performance.now() - startedAt) / 1000,
        { method: c.req.method, route },
      );
    }
  };
}
