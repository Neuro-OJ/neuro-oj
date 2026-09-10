import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { registerPlatformMetrics } from "../metrics/platform.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("platform: 注册平台指标后 render 包含核心指标", () => {
  const r = createObservabilityRegistry({ strict: true });
  registerPlatformMetrics(r);
  r.inc("noj_http_requests_total", {
    method: "GET",
    route: "/",
    status: "200",
  });
  const out = r.render();
  assert(out.includes("noj_http_requests_total"), "应包含 HTTP 请求指标");
  assert(out.includes("noj_redis_up"), "应包含 Redis 指标");
});
