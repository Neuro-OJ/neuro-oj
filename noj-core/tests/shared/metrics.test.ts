import { assert, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  MetricsRegistry,
  normalizeMetricRoute,
} from "../../src/shared/base/metrics.ts";

Deno.test("metrics: counter、gauge、histogram 输出 Prometheus 格式", () => {
  const registry = new MetricsRegistry();
  registry.define("test_requests_total", "测试请求数", "counter");
  registry.define("test_in_flight", "测试并发数", "gauge");
  registry.define("test_duration_seconds", "测试耗时", "histogram");
  registry.inc("test_requests_total", { route: '/a"b' });
  registry.set("test_in_flight", 2);
  registry.observe("test_duration_seconds", 0.01, { method: "GET" });

  const output = registry.render();
  assertStringIncludes(output, "# TYPE test_requests_total counter");
  assertStringIncludes(output, 'route="/a\\"b"');
  assertStringIncludes(output, "test_duration_seconds_bucket");
  assertStringIncludes(output, 'test_duration_seconds_count{method="GET"} 1');
  assertStringIncludes(output, "test_in_flight 2");
});

Deno.test("metrics: 动态路径归一化且不保留敏感标识符", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert(
    normalizeMetricRoute(`/api/v1/submissions/${id}/status`).endsWith(
      "/:id/status",
    ),
  );
  assert(
    normalizeMetricRoute(
      "/users/alice/private-profile",
      "/users/:id/private-profile",
    ) === "/users/:id/private-profile",
  );
  assert(
    normalizeMetricRoute(
      "/x/very-long-user-token-that-should-not-be-a-label-aaaaaaaa",
    ) === "/x/:param",
  );
});
