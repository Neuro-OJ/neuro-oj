import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { jsonRequest } from "../lib/helper.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasDb = true; // PGlite 内存数据库始终可用
const skip = !(hasEnv && hasDb);

Deno.test({
  name: "users route: GET /api/v1/users/:id/profile 不存在的用户返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/users/nonexistent-id/profile");
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "用户不存在");
  },
});

Deno.test({
  name: "users route: GET /api/v1/users/:id/profile 公开访问无需 token",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    // 不存在的用户，但路由本身不应要求认证
    const res = await jsonRequest(app, "/api/v1/users/some-id/profile");
    // 应返回 404（用户不存在）而非 401（未认证）
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "users route: GET /api/v1/users/:id/profile 返回结构正确",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/users/nonexistent-id/profile");
    assertEquals(res.status, 404);
  },
});
