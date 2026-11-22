/**
 * 域比赛 SSE 路由冒烟测试。
 *
 * 0.11 起只存在显式域入口 `/domains/:slug/contests/:id/events`；旧无域
 * `/contests/:id/events` 与其余无域比赛路由一起删除，这里同时断言它已不存在。
 */
import { Hono } from "hono";
import { assertEquals } from "jsr:@std/assert@^1";
import { AppError } from "../../../../shared/base/errors.ts";
import { domainContestSseRouter } from "../../routes/sse.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", domainContestSseRouter);
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

Deno.test("contest SSE: 域入口对不存在的竞赛返回 404", async () => {
  const res = await buildApp().request(
    "/domains/main/contests/00000000-0000-0000-0000-000000000000/events",
  );
  assertEquals(res.status, 404);
});

Deno.test("contest SSE: 旧无域入口已删除（不再挂载任何路由）", async () => {
  const res = await buildApp().request(
    "/contests/00000000-0000-0000-0000-000000000000/events",
  );
  assertEquals(res.status, 404);
});
