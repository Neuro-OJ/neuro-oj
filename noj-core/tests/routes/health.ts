import { createApp } from "../../src/app.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("app: /health/live 200", async () => {
  const app = createApp();
  const res = await app.request("/health/live");
  assert(res.status === 200, "live 应 200");
});

Deno.test("app: /metrics 返回 Prometheus 文本", async () => {
  const app = createApp();
  const res = await app.request("/metrics");
  assert(res.status === 200, "metrics 应 200");
  assert(
    (res.headers.get("content-type") ?? "").includes("text/plain"),
    "应为 text/plain",
  );
});
