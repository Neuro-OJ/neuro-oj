import { assertEquals, assertExists } from "jsr:@std/assert@^1";
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
