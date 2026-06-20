import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");

Deno.test({
  name: "problems route: GET /api/v1/problems 返回分页列表",
  ignore: !hasDb,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(typeof body.total, "number");
    assertEquals(typeof body.page, "number");
    assertEquals(typeof body.limit, "number");
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems 支持分页参数",
  ignore: !hasDb,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems?page=1&limit=5");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.page, 1);
    assertEquals(body.limit, 5);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems/:id 不存在的题目返回 404",
  ignore: !hasDb,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems/nonexistent");
    assertEquals(res.status, 404);

    const body = await res.json();
    assertEquals(body.error, "题目不存在");
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems XSS 防护 — 响应格式为 JSON",
  ignore: !hasDb,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems");
    assertEquals(res.headers.get("content-type")?.includes("application/json"), true);
  },
});
