import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { httpMetricsMiddleware } from "../middleware/http-metrics.ts";
import { requestContext } from "../middleware/request-context.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("middleware: 请求后指标增加", async () => {
  const r = createObservabilityRegistry();
  r.define({
    name: "noj_http_requests_total",
    help: "HTTP 请求总数",
    type: "counter",
    owner: "platform",
    labels: ["method", "route", "status"],
  });
  r.define({
    name: "noj_http_request_duration_seconds",
    help: "HTTP 请求耗时",
    type: "histogram",
    owner: "platform",
    labels: ["method", "route"],
  });
  const app = new Hono();
  app.use("*", httpMetricsMiddleware(r));
  app.get("/ok", (c) => c.text("ok"));
  await app.request("/ok");
  const out = r.render();
  assert(
    out.includes(
      'noj_http_requests_total{method="GET",route="/ok",status="200"} 1',
    ),
    `请求计数应为 1，实际渲染：${out}`,
  );
  assert(
    out.includes(
      'noj_http_request_duration_seconds_count{method="GET",route="/ok"} 1',
    ),
    "应记录 1 次耗时观测",
  );
});

Deno.test("middleware: requestContext 设置 X-Request-Id", async () => {
  const app = new Hono();
  app.use("*", requestContext);
  app.get("/ok", (c) => c.text("ok"));
  const res = await app.request("/ok");
  assert(res.headers.has("X-Request-Id"), "应包含 X-Request-Id");
});
