import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import rankings from "../../src/routes/rankings.ts";
import { AppError } from "../../src/lib/errors.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { checkIns, users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { eq } from "drizzle-orm";

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

/**
 * 创建测试用户并插入当月签到记录，返回 user_id。
 * 使用当月固定日期（MM-01/MM-02），避免月初跨月导致的计数不确定性。
 */
async function seedCheckinUser(
  username: string,
  daysInMonth: number,
): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const month = new Date().toISOString().slice(0, 7);
  await db.insert(users).values({
    id,
    username,
    email: `${username}-${Date.now()}@test.com`,
    password_hash: await hashPassword("TestRankPass1"),
    role: "user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  for (let day = 1; day <= daysInMonth; day++) {
    await db.insert(checkIns).values({
      id: crypto.randomUUID(),
      user_id: id,
      checkin_date: `${month}-${String(day).padStart(2, "0")}`,
      streak: 1,
      created_at: new Date().toISOString(),
    });
  }
  return id;
}

async function cleanupCheckinUsers(ids: string[]): Promise<void> {
  const db = getDb();
  for (const id of ids) {
    await db.delete(checkIns).where(eq(checkIns.user_id, id));
    await db.delete(users).where(eq(users.id, id));
  }
}

Deno.test({
  name:
    "rankings route: GET /checkin 公开返回月度活跃榜且排序正确（issue #184）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userIdA = await seedCheckinUser(`checkin_rank_a_${Date.now()}`, 1);
    const userIdB = await seedCheckinUser(`checkin_rank_b_${Date.now()}`, 2);
    try {
      const app = createTestApp();
      const res = await app.fetch(
        jsonRequest("GET", "/api/v1/rankings/checkin?page=1&per_page=20"),
      );
      assertEquals(res.status, 200);
      const json = await res.json() as {
        data: {
          rank: number;
          user_id: string;
          username: string;
          days: number;
        }[];
        pagination: unknown;
        user_rank: null;
      };
      assertEquals(json.data.length, 2);
      // days DESC → B(2) 在 A(1) 之前
      assertEquals(json.data[0].user_id, userIdB);
      assertEquals(json.data[0].days, 2);
      assertEquals(json.data[1].user_id, userIdA);
      assertEquals(json.data[1].days, 1);
      assertEquals(json.data[0].rank, 1);
      assertExists(json.pagination);
      assertEquals(json.user_rank, null);
    } finally {
      await cleanupCheckinUsers([userIdA, userIdB]);
    }
  },
});

Deno.test({
  name: "rankings route: GET /checkin 登录时返回 user_rank（issue #184）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userIdA = await seedCheckinUser(`checkin_rank_c_${Date.now()}`, 1);
    try {
      const token = await signToken({ sub: userIdA, role: "user" });
      const app = createTestApp();
      const res = await app.fetch(
        jsonRequest("GET", "/api/v1/rankings/checkin", undefined, {
          Authorization: `Bearer ${token}`,
        }),
      );
      assertEquals(res.status, 200);
      const json = await res.json() as { user_rank: number | null };
      assertEquals(json.user_rank, 1);
    } finally {
      await cleanupCheckinUsers([userIdA]);
    }
  },
});

Deno.test({
  name: "rankings route: GET /checkin?month=非法 返回 400（issue #184）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createTestApp();
    const res = await app.fetch(
      jsonRequest("GET", "/api/v1/rankings/checkin?month=2026-13"),
    );
    assertEquals(res.status, 400);
  },
});
