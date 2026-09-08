/**
 * contest SSE 路由冒烟测试。
 */
import { Hono } from "hono";
import { assertEquals } from "jsr:@std/assert@^1";
import { AppError } from "../../../../shared/base/errors.ts";
import contestSse from "../../routes/sse.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", contestSse);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    return c.json({ error: "internal" }, 500);
  });
  return app;
}

Deno.test("contest SSE: 不存在的竞赛返回 404", async () => {
  const res = await buildApp().request(
    "/contests/00000000-0000-0000-0000-000000000000/events",
  );
  assertEquals(res.status, 404);
});
