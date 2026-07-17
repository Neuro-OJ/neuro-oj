/**
 * authMiddleware / adminMiddleware 单元测试。
 *
 * 使用裸 `app.fetch(new Request(...))` 或 `jsonRequest()` 直接走中间件，
 * 不依赖 createApp() 中注册的路由。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { initRedisForTest } from "../lib/helper.ts";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../../src/middleware/auth.ts";
import { AppError } from "../../src/lib/errors.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { jsonRequest } from "../lib/helper.ts";

// PR-1：authMiddleware 校验 JWT 撤销需 Redis
await initRedisForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");

/**
 * 注册与 src/app.ts 等价的最小 onError（评审修复 H2 衍生：middleware 抛
 * AppError 后必须被捕获才能形成 JSON 响应，否则 Hono 默认 500）。
 *
 * 与生产 onError 行为一致：AppError → 对应 statusCode + {error, code, request_id}，
 * 非 AppError → 500 + {error: "服务器内部错误"}。
 *
 * 不做泛型推导（避免 Hono 4 复杂泛型不兼容），调用方负责传入具体类型。
 */
// deno-lint-ignore no-explicit-any
function registerAppErrorHandler(app: Hono<any, any, "/">) {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      const requestId = crypto.randomUUID();
      return c.json(
        {
          error: err.message,
          code: err.code,
          request_id: requestId,
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });
}

/**
 * 创建带认证中间件的测试用 Hono 应用。
 */
function createTestApp() {
  const app = new Hono<{
    Variables: { userId: string; userRole: string };
  }>();

  // deno-lint-ignore no-explicit-any
  registerAppErrorHandler(app as Hono<any, any, "/">);

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
    const res = await jsonRequest(app, "/protected");
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
    // 显式覆盖 Authorization，跳过 helper 的 Bearer 前缀
    const res = await jsonRequest(app, "/protected", {
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
    const res = await jsonRequest(app, "/protected", {
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
    const res = await jsonRequest(app, "/protected", {
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

    const res = await jsonRequest(app, "/protected", { token });
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
    const res = await jsonRequest(app, "/protected", {
      headers: { Authorization: "Bearer " },
    });
    assertEquals(res.status, 401);
  },
});

/**
 * adminMiddleware 测试
 */

/**
 * 创建带 authMiddleware + adminMiddleware 的测试用 Hono 应用。
 */
function createAdminTestApp() {
  const app = new Hono<{
    Variables: { userId: string; userRole: string };
  }>();

  // deno-lint-ignore no-explicit-any
  registerAppErrorHandler(app as Hono<any, any, "/">);

  app.get("/admin-only", authMiddleware, adminMiddleware, (c) => {
    return c.json({ ok: true });
  });

  return app;
}

Deno.test({
  name: "adminMiddleware: 非管理员用户返回 403",
  ignore: !hasEnv,
  fn: async () => {
    const app = createAdminTestApp();
    const token = await signToken({ sub: "test-user-id", role: "user" });

    const res = await jsonRequest(app, "/admin-only", { token });
    assertEquals(res.status, 403);

    const body = await res.json();
    assertEquals(body.error, "需要管理员权限");
  },
});

Deno.test({
  name: "adminMiddleware: 管理员用户通过",
  ignore: !hasEnv,
  fn: async () => {
    const app = createAdminTestApp();
    const token = await signToken({ sub: "admin-user-id", role: "admin" });

    const res = await jsonRequest(app, "/admin-only", { token });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.ok, true);
  },
});

Deno.test({
  name: "adminMiddleware: 未登录用户先被 authMiddleware 拦截返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createAdminTestApp();

    const res = await jsonRequest(app, "/admin-only");
    assertEquals(res.status, 401);
  },
});
