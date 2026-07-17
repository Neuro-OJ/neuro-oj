import { assertEquals } from "jsr:@std/assert@^1";
import { initRedisForTest } from "../lib/helper.ts";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { jsonRequest } from "../lib/helper.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb;

// 模块级 bootstrap：确保表已创建（PGlite 模式）
import { resetDbForTest } from "../../src/db/connection.ts";
await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "categories route: GET /api/v1/categories 返回分类树",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/categories");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

Deno.test({
  name: "categories route: POST /api/v1/categories 未登录返回 401",
  ignore: skip || !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/categories", {
      method: "POST",
      body: { name: "新分类", slug: "new-cat" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "categories route: POST /api/v1/categories 非管理员返回 403",
  ignore: skip || !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });

    const res = await jsonRequest(app, "/api/v1/categories", {
      method: "POST",
      body: { name: "新分类", slug: "new-cat" },
      token,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "categories route: POST /api/v1/categories 缺少必填字段返回 400",
  ignore: skip || !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await jsonRequest(app, "/api/v1/categories", {
      method: "POST",
      body: { name: "" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "categories route: GET /api/v1/categories/:id 不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/categories/nonexistent");
    assertEquals(res.status, 404);
  },
});
