import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { ValidationError } from "../../src/lib/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../src/lib/pagination.ts";

/** 构造带 query 的 Hono Context（仅用于 parsePagination 测试） */
function makeCtx(query: Record<string, string>): Hono {
  const app = new Hono();
  return app;
}

function callParse(query: Record<string, string>) {
  // 借助 Hono 的 request/response 模拟触发 c.req.query()
  const app = makeCtx(query);
  app.get("/x", (c) => {
    const p = parsePagination(c);
    return c.json(p);
  });
  const qs = new URLSearchParams(query).toString();
  return app.request(`/x?${qs}`);
}

Deno.test({
  name: "pagination: 默认值 page=1, perPage=20",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await callParse({});
    const body = await res.json();
    assertEquals(body.page, 1);
    assertEquals(body.perPage, 20);
    assertEquals(body.offset, 0);
  },
});

Deno.test({
  name: "pagination: 自定义 page/perPage",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await callParse({ page: "3", per_page: "50" });
    const body = await res.json();
    assertEquals(body.page, 3);
    assertEquals(body.perPage, 50);
    assertEquals(body.offset, 100);
  },
});

Deno.test({
  name: "pagination: perPage 上限自动 clamp 到 maxPerPage",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = makeCtx({});
    app.get("/x", (c) => {
      const p = parsePagination(c, { maxPerPage: 50 });
      return c.json(p);
    });
    const res = await app.request("/x?per_page=200");
    const body = await res.json();
    assertEquals(body.perPage, 50);
  },
});

Deno.test({
  name: "pagination: page=0 抛 ValidationError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = makeCtx({});
    app.get("/x", (c) => {
      parsePagination(c);
      return c.json({ ok: true });
    });
    const res = await app.request("/x?page=0");
    assertEquals(res.status, 500); // Hono 把 throw 转 500（无 onError）
  },
});

Deno.test({
  name: "pagination: 非数字 page 抛错",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = makeCtx({});
    app.get("/x", (c) => {
      parsePagination(c);
      return c.json({ ok: true });
    });
    const res = await app.request("/x?page=abc");
    // 解析为 NaN，isInteger(NaN) === false → ValidationError
    assertEquals(res.status, 500);
  },
});

Deno.test({
  name: "pagination: buildPaginationMeta 计算 total_pages",
  fn: () => {
    assertEquals(
      buildPaginationMeta(1, 20, 100),
      { page: 1, per_page: 20, total: 100, total_pages: 5 },
    );
    assertEquals(
      buildPaginationMeta(2, 20, 100),
      { page: 2, per_page: 20, total: 100, total_pages: 5 },
    );
    assertEquals(
      buildPaginationMeta(1, 20, 0),
      { page: 1, per_page: 20, total: 0, total_pages: 0 },
    );
    // total 不能被 per_page 整除 → 向上取整
    assertEquals(
      buildPaginationMeta(1, 20, 101),
      { page: 1, per_page: 20, total: 101, total_pages: 6 },
    );
  },
});
