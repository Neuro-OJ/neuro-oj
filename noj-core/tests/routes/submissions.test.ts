import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { jsonRequest } from "../lib/helper.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasDb = true; // PGlite 内存数据库始终可用
const skip = !(hasEnv && hasDb);

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
      token: "invalid-token-here",
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 缺少字段返回 400",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: { problem_id: "1001" }, // 缺少 language 和 code
      token,
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("缺少必填字段"), true);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions/:id 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions/123");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id 有效 token 但提交不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(app, "/api/v1/submissions/nonexistent-id", {
      token,
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});

// ── 提交列表 ──

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      token: "invalid-token",
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 无数据时返回空列表和分页信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-list-empty", role: "user" });
    const res = await jsonRequest(app, "/api/v1/submissions", { token });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.data.length, 0);
    assertExists(body.pagination);
    assertEquals(body.pagination.page, 1);
    assertEquals(body.pagination.per_page, 20);
    assertEquals(body.pagination.total, 0);
    assertEquals(body.pagination.total_pages, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 按 status 筛选返回错误状态值时 400",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(app, "/api/v1/submissions?status=invalid", {
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions per_page 超过上限自动限制",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(app, "/api/v1/submissions?per_page=999", {
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.pagination.per_page, 100);
  },
});

// ── 管理员提交列表 ──

Deno.test({
  name: "admin submissions: GET /api/v1/admin/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin submissions: GET /api/v1/admin/submissions 普通用户返回 403",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-regular", role: "user" });
    const res = await jsonRequest(app, "/api/v1/admin/submissions", { token });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "需要管理员权限");
  },
});

Deno.test({
  name: "admin submissions: GET /api/v1/admin/submissions 管理员查看所有提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-admin", role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/submissions", { token });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertExists(body.pagination);
  },
});

Deno.test({
  name: "admin submissions: GET /api/v1/admin/submissions 按 user_id 筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-admin", role: "admin" });
    const res = await jsonRequest(
      app,
      "/api/v1/admin/submissions?user_id=nonexistent-user",
      { token },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.length, 0);
    assertEquals(body.pagination.total, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id/status 提交不存在时返回 404 + code + request_id",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id/status",
      { token },
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
    assertEquals(body.code, "NOT_FOUND");
    assertEquals(typeof body.request_id, "string");
    assertExists(body.request_id);
  },
});
