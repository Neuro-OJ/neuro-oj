import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import {
  findRetiredEndpoint,
  RETIRED_ENDPOINTS,
  retiredEndpointMiddleware,
} from "./retired-endpoints.ts";

Deno.test("退役清单：只匹配写入方法和动态路径", () => {
  const retired = findRetiredEndpoint("POST", "/api/v1/problems");
  assert(retired);
  assertEquals(
    findRetiredEndpoint("GET", "/api/v1/problems"),
    undefined,
  );
  assertEquals(
    findRetiredEndpoint(
      "POST",
      "/api/v1/domains/main/problems",
    ),
    undefined,
  );
  assert(
    findRetiredEndpoint(
      "POST",
      "/api/v1/problems/550e8400-e29b-41d4-a716-446655440000/self-test",
    ),
  );
});

Deno.test("退役中间件：返回 410 ENDPOINT_RETIRED 与替代入口", async () => {
  const app = new Hono();
  app.use("/api/v1/*", retiredEndpointMiddleware());
  app.post("/api/v1/problems", (c) => c.json({ ok: true }));
  app.get("/api/v1/problems", (c) => c.json({ ok: true }));

  const retired = await app.request("/api/v1/problems", { method: "POST" });
  assertEquals(retired.status, 410);
  assertEquals((await retired.json()).code, "ENDPOINT_RETIRED");
  assertEquals(
    (await (await app.request("/api/v1/problems", { method: "POST" })).json())
      .replacement,
    "POST /api/v1/domains/:slug/problems",
  );
  assertEquals(
    (await (await app.request("/api/v1/problems")).json()).ok,
    true,
  );
});

Deno.test("退役清单：每条记录都有方法、路径与替代说明", () => {
  assert(RETIRED_ENDPOINTS.length > 0);
  for (const endpoint of RETIRED_ENDPOINTS) {
    assert(endpoint.method.length > 0);
    assert(endpoint.path.startsWith("/api/v1/"));
    assert(endpoint.replacement.length > 0);
    assert(endpoint.reason.length > 0);
  }
});
