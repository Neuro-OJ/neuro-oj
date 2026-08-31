/** HTTP 指标采集中间件。 */
import type { Context, Next } from "hono";
import { metrics, normalizeMetricRoute } from "../lib/metrics.ts";

export async function metricsMiddleware(c: Context, next: Next): Promise<void> {
  const startedAt = performance.now();
  try {
    await next();
  } finally {
    const routePath = (c.req as unknown as { routePath?: string }).routePath;
    const route = normalizeMetricRoute(c.req.path, routePath);
    const labels = {
      method: c.req.method,
      route,
      status: String(c.res.status),
    };
    metrics.inc("noj_http_requests_total", labels);
    if (c.res.status >= 500) {
      metrics.inc("noj_http_request_errors_total", labels);
    }
    metrics.observe(
      "noj_http_request_duration_seconds",
      Math.max(0, performance.now() - startedAt) / 1000,
      { method: c.req.method, route },
    );
  }
}
