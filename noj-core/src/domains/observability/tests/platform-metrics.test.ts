import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import {
  PLATFORM_METRIC_NAMES,
  registerPlatformMetrics,
} from "../metrics/platform.ts";

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

Deno.test("platform: 派生指标不再进入平台指标定义", () => {
  const names: readonly string[] = PLATFORM_METRIC_NAMES;
  assert(
    !names.includes("noj_api_error_rate_percent"),
    "派生错误率指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    !names.includes("noj_api_average_latency_ms"),
    "派生平均延迟指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    names.includes("noj_http_rate_limited_total"),
    "原始限流 counter 必须保留",
  );
  assert(
    names.includes("noj_http_request_errors_total"),
    "原始错误 counter 必须保留",
  );
});
