/**
 * 搜索路由集成测试（issue #100 Task 8）。
 *
 * 覆盖 6 个路由级场景：
 * 1. 校验：q 缺失返回 400
 * 2. 校验：q 长度 <2 返回 400
 * 3. 公开搜题：命中 P 型（中文 trigram 兜底）
 * 4. 公开搜题：不返回 U 型
 * 5. 用户搜索：匿名返回 401
 * 6. 限流触发：第 3 次返回 429
 * 7. tsvector 自动更新：INSERT 后立即可搜到
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { jsonRequest } from "../lib/helper.ts";
import { connectRedis, getRedis } from "../../src/mq/connection.ts";

// 模块加载时建立一次 Redis 连接（限流中间件依赖 Redis，必须先 connect）
try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  // 清空测试相关表
  await db.delete(problems);
  await db.delete(users).where(
    sql`${users.id} <> '0'`, // 保留 root
  );

  await db.insert(problems).values([
    {
      id: "test-p-1",
      title: "动态规划",
      description: "",
      difficulty: "medium",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      number: 1,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "test-p-2",
      title: "私有题",
      description: "",
      difficulty: "hard",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      number: 1,
      type: "U",
      created_at: now,
      updated_at: now,
    },
  ]);

  await db.insert(users).values([
    {
      id: "test-admin",
      username: "admin_test_search",
      email: "admin-test-search@example.com",
      password_hash: "x",
      role: "admin",
      created_at: now,
      updated_at: now,
    },
    {
      id: "test-user",
      username: "alice_test_search",
      email: "alice-test-search@example.com",
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    },
  ]);
}

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

Deno.test({
  name: "search route: q 缺失返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search");
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.code, "VALIDATION_ERROR");
  },
});

Deno.test({
  name: "search route: q 长度 <2 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=a");
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: 匿名搜题目 '动态' 命中",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=动态");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.data);
    assertEquals(body.data.items.length >= 1, true);
    assertEquals(body.data.items[0]?.title, "动态规划");
  },
});

Deno.test({
  name: "search route: 匿名搜题目不返回 U 型",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=私有");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 0);
  },
});

Deno.test({
  name: "search route: type=user 匿名返回 401",
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

    // 固定 IP，让 Redis key 与 cleanup key 一致（getClientIp 在无 XFF 时
    // 返回 "unknown"，与 "127.0.0.1" 不匹配会产生状态泄漏）
    const testIp = "127.0.0.1";
    const rateLimitKey = `ratelimit:search:ip:${testIp}`;

    await resetDbForTest();
    await seed();

    // 清空 redis 测试 key
    const redis = getRedis();
    await redis.del(rateLimitKey);

    try {
      const app = createApp();

      // 前 2 次通过（显式传 ip，与 cleanup key 保持一致）
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });

      // 第 3 次触发限流
      const res = await jsonRequest(app, "/api/v1/search?q=test", {
        ip: testIp,
      });
      assertEquals(res.status, 429);
      assertExists(res.headers.get("retry-after"));
    } finally {
      // 清理 redis key + 全部 env vars（避免污染后续测试）
      await redis.del(rateLimitKey);
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
    }
  },
});

Deno.test({
  name: "search route: 题目创建后立即能搜到（tsvector 自动更新）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const db = getDb();
    const now = new Date().toISOString();
    // 直接 INSERT 一道题
    await db.insert(problems).values({
      id: "test-newly-created",
      title: "新鲜出炉的题目",
      description: "",
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      number: 999,
      type: "P",
      created_at: now,
      updated_at: now,
    });

    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=新鲜");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 1);
    assertEquals(body.data.items[0]?.id, "test-newly-created");
  },
});
