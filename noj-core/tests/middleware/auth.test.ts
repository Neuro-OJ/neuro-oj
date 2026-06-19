import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { authMiddleware } from "../../src/middleware/auth.ts";
import { signToken } from "../../src/lib/jwt.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");

/**
 * 创建带认证中间件的测试用 Hono 应用。
 */
function createTestApp() {
  const app = new Hono<{
    Variables: { userId: string; userRole: string };
  }>();

  app.get("/protected", authMiddleware, (c) => {
    return c.json({
      userId: c.get("userId"),
      userRole: c.get("userRole"),
    });
  });

  return app;
}

Deno.test({
  name: "middleware: 缺少 Authorization 头返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const res = await app.request("/protected");
    assertEquals(res.status, 401);

    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "middleware: 空的 Authorization 头返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const res = await app.request("/protected", {
      headers: { Authorization: "" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "middleware: 非 Bearer 格式的 Authorization 头返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const res = await app.request("/protected", {
      headers: { Authorization: "Token abc123" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "middleware: 无效的 Bearer token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "middleware: 有效的 Bearer token 通过认证并设置 userId/userRole",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const token = await signToken({ sub: "test-user-id", role: "admin" });

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.userId, "test-user-id");
    assertEquals(body.userRole, "admin");
  },
});

Deno.test({
  name: "middleware: 'Bearer ' 前缀后无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer " },
    });
    assertEquals(res.status, 401);
  },
});
