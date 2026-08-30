import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";

Deno.test({
  name: "health: GET /health 返回服务状态 JSON",
  fn: async () => {
    const app = createApp();
    const res = await app.request("/health");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.service, "noj-core");
    assertEquals(body.version, "0.1.0");
    assertExists(body.status);
    assertExists(body.database);
    assertExists(body.redis);
    assertExists(body.consumer);
  },
});

Deno.test({
  name: "health: liveness 不依赖数据库和 Redis",
  fn: async () => {
    const app = createApp();
    const res = await app.request("/health/live");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "alive");
  },
});

Deno.test({
  name: "health: readiness 依赖未就绪时返回 503",
  fn: async () => {
    const app = createApp();
    const res = await app.request("/health/ready");
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.status, "not_ready");
  },
});

Deno.test({
  name: "health: metrics 返回 Prometheus 文本且不暴露动态标识符",
  fn: async () => {
    const app = createApp();
    const id = "123e4567-e89b-12d3-a456-426614174000";
    await app.request(`/api/v1/submissions/${id}/status`);
    const res = await app.request("/metrics");
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("content-type"),
      "text/plain; version=0.0.4; charset=utf-8",
    );
    const text = await res.text();
    assertStringIncludes(text, "noj_http_requests_total");
    assert(!text.includes(id));
  },
});
