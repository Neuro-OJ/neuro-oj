import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { upsertSearchEntry } from "../../services/index-writer.ts";
import {
  buildProblemEntry,
  buildUserEntry,
} from "../../services/index-writer.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: "p-search-route-1",
    title: "动态规划",
    description: "入门",
    difficulty: "medium",
    runtime_config: {
      evaluator: {
        image: "x",
        command: "x",
        time_limit_ms: 1000,
        memory_limit_mb: 128,
      },
      solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
    },
    number: 1,
    type: "P",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: "u-search-route-1",
    username: "alice_route",
    email: "alice-route@example.com",
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await upsertSearchEntry((await buildProblemEntry("p-search-route-1"))!);
  await upsertSearchEntry((await buildUserEntry("u-search-route-1"))!);
}

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

Deno.test({
  name: "search route: grouped 模式返回题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=动态&types=problem,user&per_type=5",
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.mode, "grouped");
    assertEquals(body.data.groups.problem.items.length, 1);
  },
});

Deno.test({
  name: "search route: flat 模式管理员可搜用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=alice&type=user",
      { token: await createAdminToken() },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 1);
  },
});

Deno.test({
  name: "search route: 匿名搜用户返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=alice&type=user");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "search route: 限流触发返回 429",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_ANON", "2");
    const testIp = "127.0.0.1";
    const rateLimitKey = `ratelimit:search:ip:${testIp}`;
    await resetDbForTest();
    await seed();
    const redis = getRedis();
    await redis.del(rateLimitKey);
    try {
      const app = createApp();
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      const res = await jsonRequest(app, "/api/v1/search?q=test", {
        ip: testIp,
      });
      assertEquals(res.status, 429);
      assertExists(res.headers.get("retry-after"));
    } finally {
      await redis.del(rateLimitKey);
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
    }
  },
});

// ── 2026-09-21 修复：登录用户走用户维度桶（校园机房 NAT 场景） ──
// 触发条件：多用户共享同一出口 IP（NAT），其中登录用户的搜索不应被
// 匿名 IP 配额挤占。
Deno.test({
  name: "search route: 登录用户走用户维度桶，不受共享 IP 匿名配额影响",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_ANON", "1");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_AUTHED", "10");
    // 模拟学校机房：所有用户共用同一出口 IP
    const natIp = "203.0.113.7";
    const anonKey = `ratelimit:search:ip:${natIp}`;
    await resetDbForTest();
    await seed();
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    const userToken = await createUserToken("user");
    const redis = getRedis();
    await redis.del(anonKey);
    try {
      const app = createApp();
      // 匿名请求把共享 IP 的匿名配额（1）打满
      const anonFirst = await jsonRequest(app, "/api/v1/search?q=aa", {
        ip: natIp,
      });
      assertEquals(anonFirst.status, 200);
      const anonSecond = await jsonRequest(app, "/api/v1/search?q=bb", {
        ip: natIp,
      });
      assertEquals(anonSecond.status, 429, "匿名 IP 桶应已超限");

      // 登录用户在同一 IP 下仍可搜索：走用户桶（上限 10），不被 IP 桶牵连。
      // 修复前路由恒传 "anon" → 此处也会 429。
      const authed = await jsonRequest(app, "/api/v1/search?q=test", {
        ip: natIp,
        token: userToken,
      });
      assertEquals(
        authed.status,
        200,
        "登录用户不得被共享 IP 的匿名配额挤占（NAT 场景）",
      );

      // 用户维度自己超限后仍会 429
      let foundUserKey = false;
      let scanCursor = "0";
      do {
        const [next, keys] = await redis.scan(
          scanCursor,
          "MATCH",
          "ratelimit:search:user:*",
          "COUNT",
          100,
        );
        scanCursor = next;
        if (keys.length > 0) foundUserKey = true;
      } while (scanCursor !== "0");
      assertEquals(foundUserKey, true, "登录请求必须写入用户维度计数键");
    } finally {
      await redis.del(anonKey);
      await clearUserSearchKeys(redis);
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_AUTHED");
    }
  },
});

Deno.test({
  name: "search route: 登录用户仍受用户维度上限约束（429）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_AUTHED", "2");
    await resetDbForTest();
    await seed();
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    const userToken = await createUserToken("user");
    const redis = getRedis();
    const clear = async () => {
      await clearUserSearchKeys(redis);
    };
    await clear();
    try {
      const app = createApp();
      for (let i = 0; i < 2; i++) {
        const res = await jsonRequest(app, `/api/v1/search?q=xx${i}`, {
          token: userToken,
        });
        assertEquals(res.status, 200);
      }
      const third = await jsonRequest(app, "/api/v1/search?q=z", {
        token: userToken,
      });
      assertEquals(third.status, 429, "用户维度超限必须 429");
    } finally {
      await clear();
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_AUTHED");
    }
  },
});

/** 清理用户维度计数键（RedisClient 无 KEYS，用 SCAN 迭代）。 */
async function clearUserSearchKeys(
  redis: ReturnType<typeof getRedis>,
): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      "ratelimit:search:user:*",
      "COUNT",
      100,
    );
    cursor = next;
    for (const k of keys) await redis.del(k);
  } while (cursor !== "0");
}

async function createAdminToken(): Promise<string> {
  const { createUserToken } = await import("../../../../../tests/helper.ts");
  return createUserToken("admin");
}
