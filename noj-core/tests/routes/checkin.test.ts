import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import checkin from "../../src/routes/checkin.ts";
import { AppError } from "../../src/lib/errors.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb } from "../../src/db/connection.ts";
import { checkIns, users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { jsonRequest } from "../lib/helper.ts";

const hasEnv = !!Deno.env.get("DATABASE_URL") &&
  !!Deno.env.get("JWT_SECRET");

/**
 * 注册最小 onError，与 src/app.ts 等价（处理 AppError → statusCode + body）。
 * 使用泛型匹配 src/app.ts 的 Hono 变量类型。
 */
function registerAppErrorHandler(
  app: Hono<{ Variables: { userId: string; userRole: string } }>,
) {
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

function createTestApp() {
  const app = new Hono<{
    Variables: { userId: string; userRole: string };
  }>();
  registerAppErrorHandler(app);
  app.route("/api/v1/checkin", checkin);
  return app;
}

async function createTestUser(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await db.insert(users).values({
    id,
    username: `checkin_rt_${unique}`,
    email: `checkin_rt_${unique}@test.com`,
    password_hash: await hashPassword("TestCheckinPass1"),
    role: "user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

async function cleanup(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(checkIns).where(eq(checkIns.user_id, userId));
  await db.delete(users).where(eq(users.id, userId));
}

Deno.test({
  name: "checkin route: POST 未登录返回 401",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await jsonRequest(app, "/api/v1/checkin", { method: "POST" });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "checkin route: GET /today 未登录返回 401",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await jsonRequest(app, "/api/v1/checkin/today");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "checkin route: POST 已登录首次签到返回 200 + streak=1",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const token = await signToken({ sub: userId, role: "user" });
      const app = createTestApp();
      const res = await jsonRequest(app, "/api/v1/checkin", {
        method: "POST",
        token,
      });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        data: { checked_in: boolean; streak: number };
      };
      assertEquals(body.data.checked_in, true);
      assertEquals(body.data.streak, 1);
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin route: 同日重复 POST 返回 409 CONFLICT_ERROR",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const token = await signToken({ sub: userId, role: "user" });
      const app = createTestApp();
      // 第一次签到
      await jsonRequest(app, "/api/v1/checkin", { method: "POST", token });
      // 第二次签到：409
      const res = await jsonRequest(app, "/api/v1/checkin", {
        method: "POST",
        token,
      });
      assertEquals(res.status, 409);
      const body = await res.json() as { code: string };
      assertEquals(body.code, "CONFLICT_ERROR");
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin route: GET /today 未签到返回 checked_in=false",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const token = await signToken({ sub: userId, role: "user" });
      const app = createTestApp();
      const res = await jsonRequest(app, "/api/v1/checkin/today", { token });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        data: { checked_in: boolean; streak: number };
      };
      assertEquals(body.data.checked_in, false);
      assertEquals(body.data.streak, 0);
    } finally {
      await cleanup(userId);
    }
  },
});

Deno.test({
  name: "checkin route: GET /today 已签到返回 streak",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userId = await createTestUser();
    try {
      const token = await signToken({ sub: userId, role: "user" });
      const app = createTestApp();
      // 先签到
      await jsonRequest(app, "/api/v1/checkin", { method: "POST", token });
      // 再查询
      const res = await jsonRequest(app, "/api/v1/checkin/today", { token });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        data: { checked_in: boolean; streak: number };
      };
      assertEquals(body.data.checked_in, true);
      assertEquals(body.data.streak, 1);
    } finally {
      await cleanup(userId);
    }
  },
});
