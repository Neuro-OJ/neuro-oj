import {
  createObservabilityRegistry,
  normalizeMetricRoute,
  validateMetricDefinition,
} from "../../../src/shared/observability/index.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("registry: counter inc/sum/render", () => {
  const r = createObservabilityRegistry({ strict: true });
  r.define({
    name: "noj_http_requests_total",
    help: "HTTP 请求总数",
    type: "counter",
    owner: "platform",
  });
  r.inc("noj_http_requests_total", {
    method: "GET",
    route: "/health",
    status: "200",
  });
  assert(r.sum("noj_http_requests_total") === 1, "sum 应为 1");
  const out = r.render();
  assert(
    out.includes(
      'noj_http_requests_total{method="GET",route="/health",status="200"} 1',
    ),
    "render 应包含序列",
  );
});

Deno.test("registry: 未定义指标写入是 no-op 且不抛错", () => {
  const r = createObservabilityRegistry();
  r.inc("noj_unknown_total");
  assert(r.sum("noj_unknown_total") === 0, "未定义指标 sum 应为 0");
});

Deno.test("registry: 非法标签被丢弃并产生自观测计数", () => {
  const r = createObservabilityRegistry();
  r.define({
    name: "noj_test_total",
    help: "测试",
    type: "counter",
    owner: "platform",
  });
  r.inc("noj_test_total", { user_id: "u-123" });
  assert(r.sum("noj_test_total") === 0, "非法标签样本应被丢弃");
  assert(
    r.sum("noj_observability_write_errors_total") >= 1,
    "应记录写错误",
  );
});

Deno.test("registry: 基数超限丢弃新序列", () => {
  const r = createObservabilityRegistry({ maxSeriesPerMetric: 2 });
  r.define({
    name: "noj_test_total",
    help: "测试",
    type: "counter",
    owner: "platform",
    labels: ["route"],
  });
  r.inc("noj_test_total", { route: "/a" });
  r.inc("noj_test_total", { route: "/b" });
  r.inc("noj_test_total", { route: "/c" });
  assert(r.sum("noj_test_total") === 2, "只应保留前两个序列");
  assert(
    r.sum("noj_observability_metric_dropped_total") >= 1,
    "应记录丢弃",
  );
});

Deno.test("registry: strict 模式类型冲突抛错", () => {
  const r = createObservabilityRegistry({ strict: true });
  r.define({
    name: "noj_test_total",
    help: "测试",
    type: "counter",
    owner: "platform",
  });
  let threw = false;
  try {
    r.define({
      name: "noj_test_total",
      help: "测试",
      type: "gauge",
      owner: "platform",
    });
  } catch {
    threw = true;
  }
  assert(threw, "strict 模式类型冲突应抛错");
});

Deno.test("validateMetricDefinition: 拒绝动态 ID 标签", () => {
  const errors = validateMetricDefinition({
    name: "noj_test_total",
    help: "测试",
    type: "counter",
    owner: "submission",
    labels: ["user_id"],
  });
  assert(errors.length > 0, "user_id 标签应被拒绝");
});

Deno.test("normalizeMetricRoute: 隐藏 UUID 和数字", () => {
  assert(
    normalizeMetricRoute(
      "/api/v1/submissions/550e8400-e29b-41d4-a716-446655440000",
    ) === "/api/v1/submissions/:id",
    "UUID 应归一化为 :id",
  );
  assert(
    normalizeMetricRoute("/api/v1/users/123") === "/api/v1/users/:id",
    "数字应归一化为 :id",
  );
});
