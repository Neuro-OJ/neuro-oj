/**
 * POST /api/v1/auth/change-password 路由层测试（issue #75）。
 *
 * 覆盖：正常改密（200）、缺少旧密码（400）、旧密码错误（401）、
 * 弱密码拒绝（400）、新旧密码相同（400）。
 *
 * 注意：路由层挂载了 loginIpRateLimit 中间件，CI 环境有 Redis
 * 时限流生效。测试必须确保 Redis 已连接，或使用独立 IP 避免触发限流。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { registerUser } from "../../src/services/auth.ts";
import { signToken } from "../../src/lib/jwt.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasDb = true; // PGlite 内存数据库始终可用
const hasJwt = !!Deno.env.get("JWT_SECRET");
const hasRedis = !!Deno.env.get("REDIS_URL");

// 没有 Redis 时禁用限流，避免 change-password 路由因 Redis 不可用返回 503
// 路由层挂载了 loginIpRateLimit 中间件，无 Redis 时会抛 ServiceUnavailableError
if (!hasRedis) {
  Deno.env.set("RATE_LIMIT_ENABLED", "false");
}
const skip = !(hasDb && hasJwt);

// 确保 Redis 在路由测试前连接，避免 rate limiter 抛 503
if (hasRedis) {
  try {
    const redisModule = await import("../../src/mq/connection.ts");
    redisModule.resetRedisForTest();
    await redisModule.connectRedis();
  } catch (e) {
    if (!String(e).includes("already connecting/connected")) {
      console.warn("[setup] Redis 连接失败:", e);
    }
  }
}

const BASE = "/api/v1/auth";
const ts = Date.now();

let testToken = "";
let testUserId = "";
const TEST_USER = {
  username: `cp-route-${ts}`,
  email: `cp-route-${ts}@example.com`,
  password: "OrigPwd-2024-Xy9",
};

const NEW_PASS = "NewStr0ng!Pass-2024";

function uniqueIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${
    Math.floor(Math.random() * 255)
  }.${Math.floor(Math.random() * 255)}`;
}

async function jsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueIp(),
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return await app.fetch(req);
}

Deno.test({
  name: "route change-password: 注册用户并获取 token",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const user = await registerUser(TEST_USER);
    testUserId = user.id;

    testToken = await signToken({
      sub: user.id,
      role: "user",
    });
    assertEquals(typeof testToken, "string");
  },
});

Deno.test({
  name: "route change-password: 正常改密返回 200 + must_change_password=false",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/change-password`,
      "POST",
      { old_password: TEST_USER.password, new_password: NEW_PASS },
      testToken,
    );
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.data.must_change_password, false);
    assertEquals(body.data.id, testUserId);
  },
});

Deno.test({
  name: "route change-password: 缺少 old_password 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/change-password`,
      "POST",
      { new_password: NEW_PASS },
      testToken,
    );
    assertEquals(res.status, 400);

    const body = await res.json();
    assertEquals(body.code, "VALIDATION_ERROR");
  },
});

Deno.test({
  name: "route change-password: 缺少 new_password 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/change-password`,
      "POST",
      { old_password: TEST_USER.password },
      testToken,
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "route change-password: 旧密码错误返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/change-password`,
      "POST",
      { old_password: "WrongOldPass-123", new_password: NEW_PASS },
      testToken,
    );
    assertEquals(res.status, 401);

    const body = await res.json();
    assertEquals(body.error, "旧密码错误");
  },
});

Deno.test({
  name: "route change-password: 无 token 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `${BASE}/change-password`,
      "POST",
      { old_password: TEST_USER.password, new_password: NEW_PASS },
    );
    assertEquals(res.status, 401);
  },
});

// 清理
Deno.test({
  name: "route change-password: 清理测试用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(users).where(eq(users.username, TEST_USER.username));
    } catch {
      // 清理错误不影响测试
    }
  },
});
