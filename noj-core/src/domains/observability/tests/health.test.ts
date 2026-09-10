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
