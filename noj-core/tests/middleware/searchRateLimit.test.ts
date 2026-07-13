import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { type Context, Hono } from "hono";
import { searchRateLimit } from "../../src/middleware/searchRateLimit.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../src/mq/connection.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { AppError } from "../../src/lib/errors.ts";

await resetDbForTest();

// 模块加载时建立一次 Redis 连接（中间件计数依赖 Redis，必须先 connect）
resetRedisForTest();
try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

/**
 * 测试用 onError：将 AppError 映射为对应 HTTP 状态码
 * （与 app.ts onError 行为等价）。
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
      err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    );
  }
  console.error("未处理的错误:", err);
  return c.json({ error: "服务器内部错误", code: "INTERNAL_ERROR" }, 500);
}

Deno.test({
  name: "search rate limit: 超过阈值返回 429",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 强制启用限流（测试默认禁用）
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_ANON", "3");

    const app = new Hono();
    app.onError(handleError);
    app.get("/test", searchRateLimit("anon"), (c) => c.text("ok"));

    // 清空 redis 测试 key
    const redis = getRedis();
    const key = "ratelimit:search:ip:127.0.0.1";
    await redis.del(key);

    try {
      // 前 3 次应通过
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/test", {
          headers: { "x-forwarded-for": "127.0.0.1" },
        });
        assertEquals(res.status, 200);
      }

      // 第 4 次触发限流
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      assertEquals(res.status, 429);
      assertExists(res.headers.get("retry-after"));
      assertEquals(res.headers.get("x-ratelimit-limit"), "3");
    } finally {
      // 清理 redis key + 全部 env vars（避免污染后续测试）
      await redis.del(key);
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
    }
  },
});
