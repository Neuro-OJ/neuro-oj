import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(hasDb && hasJwt);

const BASE = "/api/v1/auth";
const ts = Date.now();

/**
 * 从登录响应中提取 token。
 */
function _extractToken(res: Response): string {
  return res.headers.get("x-test-token") || "";
}

/**
 * 发送 JSON 请求的辅助函数。
 * 使用 app.fetch()（而非 app.request()）以确保与 Hono 路由兼容。
 */
async function jsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return await app.fetch(req);
}

async function cleanupUser(username: string) {
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.username, username));
  } catch {
    // ignore
  }
}

Deno.test({
  name: "routes: POST /register 成功返回 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: `route_user_${ts}`,
      email: `route_user_${ts}@example.com`,
      password: "TestPwd-2024-Xy9",
    });

    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.username, `route_user_${ts}`);
    assertEquals(body.data.role, "user");
    assertEquals("password_hash" in body.data, false);
  },
});

Deno.test({
  name: "routes: POST /register 缺少字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: "abc",
      // 缺少 email 和 password
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  },
});

Deno.test({
  name: "routes: POST /register 用户名格式无效返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: "@invalid!",
      email: "test@test.com",
      password: "TestPwd-2024a",
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "用户名仅允许字母、数字和下划线，长度 3-30");
  },
});

Deno.test({
  name: "routes: POST /register 密码过短返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: "shortpwd",
      email: "test@test.com",
      password: "123",
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "密码长度不能少于 8 位");
  },
});

Deno.test({
  name: "routes: POST /register 邮箱格式无效返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: "validuser",
      email: "not-an-email",
      password: "TestPwd-2024a",
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "邮箱格式不正确");
  },
});

Deno.test({
  name: "routes: POST /register 重复注册返回 409",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();

    // 第一次注册
    const res1 = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: `dup_user_${ts}`,
      email: `dup_user_${ts}@example.com`,
      password: "TestPwd-2024-Xy9",
    });
    assertEquals(res1.status, 201);

    // 重复注册相同用户名
    const res2 = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: `dup_user_${ts}`,
      email: `other-${ts}@example.com`,
      password: "TestPwd-2024-Xy9",
    });
    assertEquals(res2.status, 409);
    const body = await res2.json();
    assertEquals(body.error, "用户名已存在");
  },
});

Deno.test({
  name: "routes: POST /login 成功返回 200 + JWT",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const user = `login_test_${ts}`;

    // 先注册
    await jsonRequest(app, `${BASE}/register`, "POST", {
      username: user,
      email: `${user}@example.com`,
      password: "TestPwd-2024-Xy9",
    });

    // 再登录
    const res = await jsonRequest(app, `${BASE}/login`, "POST", {
      login: user,
      password: "TestPwd-2024-Xy9",
    });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.user.username, user);
    assertEquals(typeof body.data.token, "string");
    assertEquals(body.data.token.split(".").length, 3);
  },
});

Deno.test({
  name: "routes: POST /login 错误密码返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const user = `login_fail_${ts}`;

    await jsonRequest(app, `${BASE}/register`, "POST", {
      username: user,
      email: `${user}@example.com`,
      password: "CorrectPwd-Ab1",
    });

    const res = await jsonRequest(app, `${BASE}/login`, "POST", {
      login: user,
      password: "WrongPwd-Cd2",
    });

    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "用户名或密码错误");
  },
});

Deno.test({
  name: "routes: GET /me 成功返回用户信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const user = `me_test_${ts}`;

    // 注册
    await jsonRequest(app, `${BASE}/register`, "POST", {
      username: user,
      email: `${user}@example.com`,
      password: "TestPwd-2024-Xy9",
    });

    // 登录获取 token
    const loginRes = await jsonRequest(app, `${BASE}/login`, "POST", {
      login: user,
      password: "TestPwd-2024-Xy9",
    });
    const { token } = (await loginRes.json()).data;

    // 访问 /me
    const meRes = await jsonRequest(app, `${BASE}/me`, "GET", undefined, token);
    assertEquals(meRes.status, 200);
    const meBody = await meRes.json();
    assertEquals(meBody.data.username, user);
    assertEquals(meBody.data.password_hash, undefined);
  },
});

Deno.test({
  name: "routes: POST /login 成功通过邮箱登录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const user = `login_email_${ts}`;
    const email = `${user}@example.com`;

    // 先注册
    await jsonRequest(app, `${BASE}/register`, "POST", {
      username: user,
      email,
      password: "TestPwd-2024-Xy9",
    });

    // 用邮箱登录
    const res = await jsonRequest(app, `${BASE}/login`, "POST", {
      login: email,
      password: "TestPwd-2024-Xy9",
    });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.user.username, user);
    assertEquals(typeof body.data.token, "string");
  },
});

Deno.test({
  name: "routes: POST /register 用户名最短 3 字符边界",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const _user = `ab_${ts}`; // 5 字符，有效
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: "ab", // 2 字符，无效
      email: `bound_min_${ts}@example.com`,
      password: "TestPwd-2024", // 11 字符，少于 12
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "routes: POST /register 用户名最长 30 字符边界",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    // 31 字符，无效
    const longName = "a".repeat(31);
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: longName,
      email: `bound_max_${ts}@example.com`,
      password: "TestPwd-2024", // 11 字符，少于 12
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "routes: POST /register 密码恰好 12 字符边界",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const user = `pw8_${ts}`;
    const res = await jsonRequest(app, `${BASE}/register`, "POST", {
      username: user,
      email: `${user}@example.com`,
      password: "TestPwd-2024a", // 恰好 12 位
    });
    assertEquals(res.status, 201);
  },
});

Deno.test({
  name: "routes: GET /me 无 token 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/me`, "GET");
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "routes: GET /me 无效 token 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/me`,
      "GET",
      undefined,
      "Bearer invalid-token",
    );
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "routes: POST /login 缺少字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/login`, "POST", {
      login: "user", // 缺少 password
    });
    assertEquals(res.status, 400);
  },
});

// 清理
Deno.test({
  name: "routes: cleanup test users",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanupUser(`route_user_${ts}`);
    await cleanupUser(`dup_user_${ts}`);
    await cleanupUser(`login_test_${ts}`);
    await cleanupUser(`login_fail_${ts}`);
    await cleanupUser(`me_test_${ts}`);
    await cleanupUser(`login_email_${ts}`);
    await cleanupUser(`pw8_${ts}`);
  },
});
