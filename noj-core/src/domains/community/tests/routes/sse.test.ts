/**
 * community SSE 路由冒烟测试。
 */
import { Hono } from "hono";
import { assertEquals } from "jsr:@std/assert@^1";
import { AppError } from "../../../../shared/base/errors.ts";
import communitySse from "../../routes/sse.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", communitySse);
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

Deno.test("community SSE: 未认证返回 401", async () => {
  const res = await buildApp().request("/community/notifications/events");
  assertEquals(res.status, 401);
});
