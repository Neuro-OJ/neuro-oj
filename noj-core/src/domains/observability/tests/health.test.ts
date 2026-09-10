import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { createHealthRouter } from "../routes/health.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("health: live 永远 200", async () => {
  const r = createObservabilityRegistry();
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health/live");
  assert(res.status === 200, "live 应 200");
});

Deno.test("health: ready 在 critical 探针 down 时 503", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({
    name: "db",
    critical: true,
    check: () => ({ status: "down" as const }),
  });
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health/ready");
  assert(res.status === 503, "ready 应 503");
});

Deno.test("health: 兼容 /health 返回 200 + degraded", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({
    name: "db",
    critical: true,
    check: () => ({ status: "down" as const }),
  });
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health");
  assert(res.status === 200, "/health 应 200");
  const body = await res.json();
  assert(body.status === "degraded", "应为 degraded");
});

Deno.test("health: ready 保留旧顶层字段且 consumer down 时 503", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({
    name: "database",
    critical: true,
    check: () => ({ status: "up" as const }),
  });
  r.registerHealthProbe({
    name: "redis",
    critical: true,
    check: () => ({ status: "up" as const }),
  });
  r.registerHealthProbe({
    name: "result_consumer",
    critical: true,
    check: () => ({ status: "down" as const }),
  });
  const app = new Hono().route("/", createHealthRouter(r));
  const res = await app.request("/health/ready");
  assert(res.status === 503, "consumer down 时 ready 应 503");
  const body = await res.json();
  assert(body.database === "ok", "应保留 database 顶层字段");
  assert(body.redis === "ok", "应保留 redis 顶层字段");
  assert(body.consumer === "error", "应保留 consumer 顶层字段");
});
