import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { AppError } from "./../src/shared/base/errors.ts";

/**
 * 辅助函数：创建带全局错误处理的测试用 Hono 应用。
 */
function createTestApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 404 | 409 | 500,
      );
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  return app;
}

Deno.test("app: AppError 返回对应的 statusCode 和错误消息", async () => {
  const app = createTestApp();

  app.get("/conflict", () => {
    throw new AppError("自定义冲突", 409);
  });

  const res = await app.fetch(new Request("http://localhost/conflict"));
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, "自定义冲突");
});

Deno.test("app: 非 AppError 的未知错误返回 500", async () => {
  const app = createTestApp();

  app.get("/crash", () => {
    throw new Error("数据库连接异常");
  });

  const res = await app.fetch(new Request("http://localhost/crash"));
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "服务器内部错误");
});

Deno.test("app: 开发环境 CORS 允许本地 UI 并暴露公共响应头", async () => {
  const previousNojEnv = Deno.env.get("NOJ_ENV");
  const previousOrigins = Deno.env.get("CORS_ALLOWED_ORIGINS");
  try {
    Deno.env.delete("NOJ_ENV");
    Deno.env.delete("CORS_ALLOWED_ORIGINS");

    const app = createApp();
    const response = await app.fetch(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );

    assertEquals(response.status, 204);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "http://localhost:3000",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Credentials"),
      "true",
    );
    const exposedHeaders =
      response.headers.get("Access-Control-Expose-Headers") ??
        "";
    for (
      const header of [
        "Retry-After",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-Request-Id",
      ]
    ) {
      assertEquals(
        exposedHeaders.toLowerCase().includes(header.toLowerCase()),
        true,
        `应暴露 ${header}`,
      );
    }
    assertEquals(response.headers.has("X-Request-Id"), true);

    const disallowed = await app.fetch(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:4000",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    assertEquals(disallowed.headers.has("Access-Control-Allow-Origin"), false);
  } finally {
    if (previousNojEnv === undefined) Deno.env.delete("NOJ_ENV");
    else Deno.env.set("NOJ_ENV", previousNojEnv);
    if (previousOrigins === undefined) {
      Deno.env.delete("CORS_ALLOWED_ORIGINS");
    } else {
      Deno.env.set("CORS_ALLOWED_ORIGINS", previousOrigins);
    }
  }
});

Deno.test("app: 退役清单机制已移除，旧默认域写入只落到 404", async () => {
  // 0.11 起不再有「登记式退役（410 + replacement）」：处理函数删除后，
  // 旧路径就是不存在。任何环境（含生产）都不该再拿到 410 兼容响应。
  const app = createApp();
  const response = await app.request("/api/v1/problems", { method: "POST" });
  assertEquals(response.status, 404);
});
