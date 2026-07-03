import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import rankings from "../../src/routes/rankings.ts";
import { AppError } from "../../src/lib/errors.ts";
import { resetDbForTest } from "../../src/db/connection.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = true && // DATABASE_URL 未设置时 PGlite 可用
  !!Deno.env.get("JWT_SECRET");

/**
 * 注册最小 onError，与 src/app.ts 等价（处理 AppError → statusCode + body）。
 * 模式与 tests/routes/checkin.test.ts 一致。
 */
function registerAppErrorHandler(
  app: Hono<{ Variables: { userId: string; userRole: string } }>,
) {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });
}

function createTestApp() {
  const app = new Hono<{
    Variables: { userId: string; userRole: string };
  }>();
  registerAppErrorHandler(app);
  app.route("/api/v1/rankings", rankings);
  return app;
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, init);
}

Deno.test({
  name: "rankings route: GET / 无需 token 公开访问",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await app.fetch(
      jsonRequest("GET", "/api/v1/rankings?page=1&limit=10"),
    );
    assertEquals(res.status, 200);
    const json = await res.json() as { data: unknown[]; pagination: unknown };
    assertEquals(Array.isArray(json.data), true);
    assertExists(json.pagination);
  },
});

Deno.test({
  name: "rankings route: GET /me 未登录返回 401",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await app.fetch(jsonRequest("GET", "/api/v1/rankings/me"));
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "rankings route: GET /?page=0 返回 400",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await app.fetch(
      jsonRequest("GET", "/api/v1/rankings?page=0"),
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "rankings route: GET /?limit=abc 返回 400",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await app.fetch(
      jsonRequest("GET", "/api/v1/rankings?limit=abc"),
    );
    assertEquals(res.status, 400);
  },
});
