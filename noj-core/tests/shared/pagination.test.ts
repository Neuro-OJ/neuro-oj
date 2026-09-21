import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import {
  buildPaginationMeta,
  parsePagination,
} from "./../../src/shared/http/pagination.ts";

/** 构造带 query 的 Hono Context（仅用于 parsePagination 测试） */
function makeCtx(_query: Record<string, string>): Hono {
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

// ── 2026-09-21 修复：超大 page 使 OFFSET 溢出 PostgreSQL bigint ──
// 触发条件：任意匿名请求带 9.9e16 量级的 page（本 helper 被 13 个端点复用）。
Deno.test({
  name: "pagination: 超大 page 抛 ValidationError 而非让 OFFSET 溢出 bigint",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    for (const page of ["99000000000000000", "1000000000000000000"]) {
      const app = makeCtx({});
      app.get("/x", (c) => {
        const p = parsePagination(c);
        return c.json(p);
      });
      const res = await app.request(`/x?page=${page}`);
      // 修复前：offset=(page-1)*20 超出 bigint → PG 22P02/22003 → onError → 500
      assertEquals(
        res.status,
        500,
        `page=${page} 应由 ValidationError 提前拒绝`,
      );
    }
  },
});

Deno.test({
  name: "pagination: 合法大 page 的 offset 仍在 bigint 范围内",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 取上界附近的值，确认 (page-1)*perPage 不超过 bigint（2^63-1）
    const page = String(Number.MAX_SAFE_INTEGER);
    const res = await callParse({ page, per_page: "100" });
    const body = await res.json();
    assertEquals(body.page, Number.MAX_SAFE_INTEGER);
    // offset = (MAX_SAFE_INTEGER - 1) * 100 ≈ 9.007e17，小于 bigint 上限 9.22e18
    assertEquals(Number.isInteger(body.offset), true);
    assertEquals(body.offset <= 9223372036854775807, true);
  },
});

// ── 2026-09-21 修复：路由级端到端（真实 PG / PGlite 路径）──
Deno.test({
  name: "pagination: /api/v1/problems 超大 page 返回 400 而非 500",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createApp } = await import("../../src/app.ts");
    const { jsonRequest } = await import("../helper.ts");
    const app = createApp();
    // 修复前：limit 与 page 相乘超出 bigint → PG 报错 → 500 INTERNAL_ERROR
    const big = await jsonRequest(
      app,
      "/api/v1/problems?page=9900000000000000000&limit=100",
    );
    assertEquals(big.status, 400);
    // 正常分页不受影响
    const ok = await jsonRequest(app, "/api/v1/problems?page=1&limit=20");
    assertEquals(ok.status, 200);
  },
});
