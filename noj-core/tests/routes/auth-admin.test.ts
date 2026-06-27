import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/users/some-id/role", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 管理员提升用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    // 目标用户存在时会成功，不存在时返回 404
    // 这里只验证鉴权通过，具体业务由服务层测试覆盖
    assertEquals(
      [200, 404].includes(res.status),
      true,
    );
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 非法角色值返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "superuser" }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name:
    "admin route: PATCH /api/v1/admin/users/:id/role 缺少 role 字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  },
});

// ─── 仪表盘统计 ──────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/dashboard/stats");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 管理员可访问",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.total_users, "number");
    assertEquals(typeof body.data.total_problems, "number");
    assertEquals(typeof body.data.total_submissions, "number");
  },
});

// ─── 题目列表 ────────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/problems 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/problems", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/problems 管理员可访问",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/problems", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(typeof body.total, "number");
  },
});

// ─── 提交详情 ────────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/submissions/:id 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/submissions/some-id");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/submissions/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/submissions/some-id", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: DELETE /api/v1/admin/submissions/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/submissions/some-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

// ─── 用户编辑 ───────────────────────────────────────────

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bio: "新简介" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 无字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 邮箱格式非法返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assertEquals(res.status, 400);
  },
});

// ─── 用户搜索筛选 ──────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/users 支持 keyword 参数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/users?keyword=admin",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/users 支持 role 参数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/users?role=admin",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});
