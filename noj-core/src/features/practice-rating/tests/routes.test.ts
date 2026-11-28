import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { initRedisForTest, jsonRequest } from "../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { signToken } from "../../../modules/access/identity/services/security/jwt.ts";
import { hashPassword } from "../../../modules/access/identity/services/security/password.ts";
import rankingsRouter from "../../../modules/read-models/queries/routes/rankings.ts";
import { AppError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { users } from "../../../shared/db/schema.ts";
import { practiceRatingRouter } from "../routes.ts";

await resetDbForTest();
await initRedisForTest();

function createTestApp() {
  const app = new Hono<{ Variables: { userId: string; userRole: string } }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    throw err;
  });
  app.route("/api/v1", practiceRatingRouter);
  app.route("/api/v1/rankings", rankingsRouter);
  return app;
}

async function createRouteUser(): Promise<{ id: string; username: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const username = `pr_rt_${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username,
    email: `${username}@test.local`,
    password_hash: await hashPassword("PracticeRatingPass1"),
    created_at: now,
    updated_at: now,
  });
  return { id, username };
}

Deno.test({
  name: "practice-rating route: /me 未登录返回 401，已登录返回 200",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createTestApp();

    const unauth = await jsonRequest(app, "/api/v1/practice-rating/me");
    assertEquals(unauth.status, 401);

    const user = await createRouteUser();
    const token = await signToken({ sub: user.id, role: "user" });
    const res = await jsonRequest(app, "/api/v1/practice-rating/me", { token });
    assertEquals(res.status, 200);
    const body = await res.json() as {
      data: { user_id: string; rating: number; top_n: number; tier: string };
    };
    assertEquals(body.data.user_id, user.id);
    assertEquals(body.data.rating, 0);
    assertEquals(body.data.top_n, 30);
    assertEquals(body.data.tier, "unrated");
  },
});

Deno.test({
  name:
    "practice-rating route: /users/:id 公开支持 UUID 与 username，不存在返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createTestApp();
    const user = await createRouteUser();

    const byId = await jsonRequest(
      app,
      `/api/v1/practice-rating/users/${user.id}`,
    );
    assertEquals(byId.status, 200);

    const byUsername = await jsonRequest(
      app,
      `/api/v1/practice-rating/users/${user.username}`,
    );
    assertEquals(byUsername.status, 200);
    const body = await byUsername.json() as { data: { user_id: string } };
    assertEquals(body.data.user_id, user.id);

    const missing = await jsonRequest(
      app,
      "/api/v1/practice-rating/users/nonexistent_user_999",
    );
    assertEquals(missing.status, 404);
  },
});

Deno.test({
  name:
    "practice-rating route: GET /rankings/practice-rating 公开可读并返回分页结构",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createTestApp();
    const res = await jsonRequest(
      app,
      "/api/v1/rankings/practice-rating?page=1&per_page=20",
    );
    assertEquals(res.status, 200);
    const body = await res.json() as {
      data: unknown[];
      pagination: { page: number; per_page: number; total: number };
      user_rank: number | null;
      user_rating: number | null;
    };
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.pagination.page, 1);
    assertEquals(body.pagination.per_page, 20);
    assertEquals(body.user_rank, null);
    assertEquals(body.user_rating, null);
  },
});
