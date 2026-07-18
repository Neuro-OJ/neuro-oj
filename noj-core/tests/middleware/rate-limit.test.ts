import { assertEquals } from "jsr:@std/assert@^1";
import {
  _resetRateLimitForTests,
  rateLimit,
} from "../../src/middleware/rate-limit.ts";
import { optionalAuthMiddleware } from "../../src/middleware/auth.ts";
import { Hono } from "hono";
import { signToken } from "../../src/lib/jwt.ts";
import { AppError } from "../../src/lib/errors.ts";
import type { Context } from "hono";
import { resetDbForTest } from "../../src/db/connection.ts";

// 显式启用限流中间件（NOJ_ENV=test 时默认关闭）
Deno.env.set("RATE_LIMIT_ENABLED", "true");
const hasEnv = !!Deno.env.get("JWT_SECRET");

type Env = { Variables: { userId?: string; userRole?: string } };

/**
 * Hono 全局错误处理（与 app.ts 一致），测试用。
 */
function handleError(err: Error, c: Context) {
  if (err instanceof AppError) {
    const extraHeaders = (err as { headers?: Record<string, string> }).headers;
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        c.header(k, v);
      }
    }
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.meta ?? {}),
      },
      err.statusCode as 429,
    );
  }
  console.error("未处理的错误:", err);
  return c.json({ error: "服务器内部错误", code: "INTERNAL_ERROR" }, 500);
}

/**
 * 创建带 optionalAuth + rateLimit 中间件的测试用 Hono 应用。
 */
function createTestApp(loggedInMs: number, loggedOutMs: number) {
  const app = new Hono<Env>();
  app.onError(handleError);
  app.get(
    "/limited",
    optionalAuthMiddleware,
    rateLimit({
      loggedInIntervalMs: loggedInMs,
      loggedOutIntervalMs: loggedOutMs,
    }),
    (c) => c.json({ ok: true }),
  );
  return app;
}

Deno.test({
  name: "rate limit: 未登录连续两次请求第二次返回 429",
  ignore: !hasEnv,
  fn: async () => {
    _resetRateLimitForTests();
    const app = createTestApp(1000, 5000);

    const r1 = await app.request("/limited");
    assertEquals(r1.status, 200);

    const r2 = await app.request("/limited");
    assertEquals(r2.status, 429);

    const body = await r2.json();
    assertEquals(body.error, "请求过于频繁，请稍后再试");
    assertEquals(body.retry_after, 5);
    assertEquals(r2.headers.get("Retry-After"), "5");
  },
});

Deno.test({
  name: "rate limit: 登录用户连续两次请求间隔 < 1s 返回 429",
  ignore: !hasEnv,
  fn: async () => {
    _resetRateLimitForTests();
    const app = createTestApp(1000, 5000);
    const token = await signToken({ sub: "user-test", role: "user" });

    const r1 = await app.request("/limited", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(r1.status, 200);

    const r2 = await app.request("/limited", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(r2.status, 429);

    const body = await r2.json();
    assertEquals(body.retry_after, 1);
    assertEquals(r2.headers.get("Retry-After"), "1");
  },
});

Deno.test({
  name: "rate limit: 不同 IP 的未登录请求互不影响",
  ignore: !hasEnv,
  fn: async () => {
    _resetRateLimitForTests();
    const app = createTestApp(1000, 5000);

    // IP A 请求一次
    const r1 = await app.request("/limited", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    assertEquals(r1.status, 200);

    // IP B 请求一次：不应被 IP A 的限流影响
    const r2 = await app.request("/limited", {
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    assertEquals(r2.status, 200);

    // IP A 第二次请求：仍在 5s 限流窗口内
    const r3 = await app.request("/limited", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    assertEquals(r3.status, 429);
  },
});

Deno.test({
  name: "rate limit: 不同登录用户互不影响",
  ignore: !hasEnv,
  fn: async () => {
    _resetRateLimitForTests();
    const app = createTestApp(1000, 5000);
    const tokenA = await signToken({ sub: "user-a", role: "user" });
    const tokenB = await signToken({ sub: "user-b", role: "user" });

    const r1 = await app.request("/limited", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assertEquals(r1.status, 200);

    const r2 = await app.request("/limited", {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assertEquals(r2.status, 200);
  },
});

Deno.test({
  name: "rate limit: 重复触发 _resetRateLimitForTests 不抛错",
  ignore: !hasEnv,
  fn: () => {
    _resetRateLimitForTests();
    _resetRateLimitForTests();
  },
});

Deno.test({
  name: "submissions 路由: GET /public/recent 未登录 per_page 上限 50",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  // 引入路由会触发 DB 连接；放在测试里加载避免顶层副作用
  // 此测试独立，不依赖前面的限流测试
  fn: async () => {
    _resetRateLimitForTests();
    await resetDbForTest();
    const { default: router } = await import("../../src/routes/submissions.ts");
    const app = new Hono<Env>();
    app.onError(handleError);
    app.route("/api/v1/submissions", router);

    const res = await app.request(
      "/api/v1/submissions/public/recent?per_page=100",
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    // 未登录 per_page 上限 50：无论 DB 中数据多少，返回 data 长度 ≤ 50
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.data.length <= 50, true);
  },
});

Deno.test({
  name: "submissions 路由: GET /public/recent 登录用户 per_page 上限 100",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetRateLimitForTests();
    await resetDbForTest();
    const { default: router } = await import("../../src/routes/submissions.ts");
    const app = new Hono<Env>();
    app.onError(handleError);
    app.route("/api/v1/submissions", router);

    const token = await signToken({ sub: "user-perpage", role: "user" });
    const res = await app.request(
      "/api/v1/submissions/public/recent?per_page=200",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    // 登录用户 per_page 上限 100：返回 data 长度 ≤ 100
    assertEquals(body.data.length <= 100, true);
  },
});

Deno.test({
  name: "submissions 路由: GET /public/recent 无 token 触发未登录限流（429）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetRateLimitForTests();
    await resetDbForTest();
    const { default: router } = await import("../../src/routes/submissions.ts");
    const app = new Hono<Env>();
    app.onError(handleError);
    app.route("/api/v1/submissions", router);

    // 第一次：无 token 走未登录限流（5s）
    const r1 = await app.request("/api/v1/submissions/public/recent");
    assertEquals(r1.status, 200);

    // 立即第二次：应触发 429
    const r2 = await app.request("/api/v1/submissions/public/recent");
    assertEquals(r2.status, 429);
    assertEquals(r2.headers.get("Retry-After"), "5");
  },
});

Deno.test({
  name: "submissions 路由: GET /public/recent 登录用户触发登录限流（429，1s）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetRateLimitForTests();
    await resetDbForTest();
    const { default: router } = await import("../../src/routes/submissions.ts");
    const app = new Hono<Env>();
    app.onError(handleError);
    app.route("/api/v1/submissions", router);

    const token = await signToken({ sub: "user-rate-test", role: "user" });

    const r1 = await app.request("/api/v1/submissions/public/recent", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(r1.status, 200);

    // 立即第二次：触发登录 1s 限流
    const r2 = await app.request("/api/v1/submissions/public/recent", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(r2.status, 429);
    assertEquals(r2.headers.get("Retry-After"), "1");
  },
});
