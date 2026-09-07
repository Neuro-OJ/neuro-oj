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

async function createAdminToken(): Promise<string> {
  const { createUserToken } = await import("../../../../../tests/helper.ts");
  return createUserToken("admin");
}
