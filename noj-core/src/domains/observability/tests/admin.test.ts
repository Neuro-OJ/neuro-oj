import { Hono } from "hono";
import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { createObservabilityAdminRouter } from "../routes/admin.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("admin: 观测路由返回快照", async () => {
  const r = createObservabilityRegistry();
  const app = new Hono().route("/dashboard", createObservabilityAdminRouter(r));
  const res = await app.request("/dashboard/observability");
  assert(res.status === 200, "应 200");
  const body = await res.json();
  assert(body.data.generated_at, "应包含 generated_at");
});
