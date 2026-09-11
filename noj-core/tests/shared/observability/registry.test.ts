import {
  createObservabilityRegistry,
  normalizeMetricRoute,
  validateMetricDefinition,
} from "../../../src/shared/observability/index.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("registry: counter inc 与 render", () => {
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
  const out = r.render();
  assert(
    out.includes(
      'noj_http_requests_total{method="GET",route="/health",status="200"} 1',
    ),
    `render 应包含序列，实际：${out}`,
  );
});

Deno.test("registry: 未定义指标写入是 no-op 且不抛错", () => {
  const r = createObservabilityRegistry();
  r.inc("noj_unknown_total");
  assert(
    !r.render().includes("noj_unknown_total"),
    "未定义指标不应出现在渲染输出中",
  );
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
  const out = r.render();
  // 样本被整体丢弃 → 该指标只剩 HELP/TYPE，没有任何值行。
  assert(
    out.includes("# TYPE noj_test_total counter"),
    `指标定义应保留，实际：${out}`,
  );
  assert(
    !/^noj_test_total[ {]/m.test(out),
    `非法标签样本应被完全丢弃，实际：${out}`,
  );
  assert(
    /noj_observability_write_errors_total 1/.test(out),
    `应记录写错误，实际：${out}`,
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
  const out = r.render();
  assert(out.includes('noj_test_total{route="/a"} 1'), "应保留 /a");
  assert(out.includes('noj_test_total{route="/b"} 1'), "应保留 /b");
  assert(
    !out.includes('noj_test_total{route="/c"}'),
    "超限序列应被丢弃",
  );
  assert(
    /noj_observability_metric_dropped_total \d+/.test(out) &&
      !out.includes("noj_observability_metric_dropped_total 0"),
    `应记录丢弃，实际：${out}`,
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
