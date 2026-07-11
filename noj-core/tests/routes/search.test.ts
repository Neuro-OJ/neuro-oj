import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { jsonRequest } from "../lib/helper.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { sql } from "drizzle-orm";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

const ts = Date.now();
const TEST_PROBLEM_ID = `tst-p-${ts}`;
const TEST_ADMIN_ID = `tst-adm-${ts}`;
const TEST_USER_ID = `tst-u-${ts}`;

// 模块级 setup：建库 + 插入测试数据 + 等待 trigger 填充 search_vector
await resetDbForTest();
{
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: TEST_PROBLEM_ID,
    title: "题面包含可搜索关键词的题目",
    description: "用于 route 测试",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: 9002,
    type: "P",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: TEST_ADMIN_ID,
    username: `tstadm-${ts}`,
    email: `tstadm-${ts}@test.noj`,
    password_hash: "hash",
    role: "admin",
    bio: "",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: TEST_USER_ID,
    username: `tstusr-${ts}`,
    email: `tstusr-${ts}@test.noj`,
    password_hash: "hash",
    role: "user",
    bio: "",
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "search route: GET /api/v1/search type=problem 公开访问 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=" + encodeURIComponent("可搜索") + "&type=problem",
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data.items), true);
    const hit = body.data.items.find((i: { id: string }) =>
      i.id === TEST_PROBLEM_ID
    );
    assertEquals(hit !== undefined, true);
  },
});

Deno.test({
  name: "search route: GET /api/v1/search 未指定 type 默认 problem",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=" + encodeURIComponent("可搜索"),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.total, "number");
  },
});

Deno.test({
  name: "search route: GET /api/v1/search type=user 非 admin 返 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const token = await signToken({ sub: TEST_USER_ID, role: "user" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=tst&type=user",
      { token },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "search route: GET /api/v1/search type=user 未登录返 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=tst&type=user",
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "search route: GET /api/v1/search type=user admin 返 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const token = await signToken({ sub: TEST_ADMIN_ID, role: "admin" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=" + encodeURIComponent(`tstusr-${ts}`) + "&type=user",
      { token },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data.items), true);
  },
});

Deno.test({
  name: "search route: q 为空返 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=&type=problem");
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: type 非法值返 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=foo&type=invalid",
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: limit > 100 返 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=foo&limit=101",
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: page=0 返 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=foo&page=0",
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: cleanup 删除测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(problems).where(sql`id = ${TEST_PROBLEM_ID}`);
    await db.delete(users).where(sql`id = ${TEST_ADMIN_ID}`);
    await db.delete(users).where(sql`id = ${TEST_USER_ID}`);
  },
});
