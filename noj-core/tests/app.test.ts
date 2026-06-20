import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../src/lib/errors.ts";

/**
 * 辅助函数：创建带全局错误处理的测试用 Hono 应用。
 */
function createTestApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 409 | 500,
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
