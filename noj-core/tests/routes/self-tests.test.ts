import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";

import { problems, selfTests, users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest, jsonRequest } from "../lib/helper.ts";

// 显式启用限流（NOJ_ENV=test 时默认关闭）
Deno.env.set("RATE_LIMIT_ENABLED", "true");

await resetDbForTest();
await initRedisForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasRedis = !!Deno.env.get("REDIS_URL");
const skip = !(hasEnv && hasRedis);

const ts = Date.now();
const USER_ID = `tst-route-st-user-${ts}`;
const OTHER_USER_ID = `tst-route-st-other-${ts}`;
const PROBLEM_ID = `tst-route-st-problem-${ts}`;
const PROBLEM_NUMBER = 90000 + (ts % 10000);
const DISPLAY_ID = `P${PROBLEM_NUMBER}`;
const now = new Date().toISOString();
let TEST_TOKEN = "";
let CREATED_SELF_TEST_ID = "";

// 模块级 setup：事务外初始化共享测试用户、题目和一个自测记录
if (!skip) {
  const db = getDb();
  await db.insert(users).values([
    {
      id: USER_ID,
      username: `tststroute-${ts}`,
      email: `tststroute-${ts}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
    {
      id: OTHER_USER_ID,
      username: `tststroute-other-${ts}`,
      email: `tststroute-other-${ts}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
  ]);
  await db.insert(problems).values({
    id: PROBLEM_ID,
    title: "路由自测题",
    description: "测试",
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
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    number: PROBLEM_NUMBER,
    owner_id: USER_ID,
    type: "P",
    created_at: now,
    updated_at: now,
  });
  TEST_TOKEN = await signToken({ sub: USER_ID, role: "user" });

  const app = createApp();
  const createRes = await jsonRequest(
    app,
    `/api/v1/problems/${PROBLEM_ID}/self-test`,
    {
      method: "POST",
      body: { language: "python3", code: "print(1)" },
      token: TEST_TOKEN,
    },
  );
  const createBody = await createRes.json();
  CREATED_SELF_TEST_ID = createBody.data.id;
}

Deno.test({
  name:
    "self-tests route: POST /api/v1/problems/:id/self-test 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${PROBLEM_ID}/self-test`,
      {
        method: "POST",
        body: { language: "python3", code: "print(1)" },
      },
    );
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "self-tests route: POST 缺少字段返回 400",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${PROBLEM_ID}/self-test`,
      {
        method: "POST",
        body: { language: "python3" },
        token: TEST_TOKEN,
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "self-tests route: POST 不存在的题目返回 404",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/problems/nonexistent/self-test",
      {
        method: "POST",
        body: { language: "python3", code: "print(1)" },
        token: TEST_TOKEN,
      },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "self-tests route: POST 正常创建返回 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${PROBLEM_ID}/self-test`,
      {
        method: "POST",
        body: { language: "python3", code: "print(1)" },
        token: TEST_TOKEN,
      },
    );
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.id.startsWith("st_"), true);
    assertEquals(body.data.status, "judging");
  },
});

Deno.test({
  name: "self-tests route: POST 支持 display_id 路径",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${DISPLAY_ID}/self-test`,
      {
        method: "POST",
        body: { language: "python3", code: "print(1)" },
        token: TEST_TOKEN,
      },
    );
    assertEquals(res.status, 201);
  },
});

Deno.test({
  name: "self-tests route: 非 owner 查询自测返回 404",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const otherToken = await signToken({ sub: OTHER_USER_ID, role: "user" });
    const res = await jsonRequest(
      app,
      `/api/v1/self-tests/${CREATED_SELF_TEST_ID}`,
      {
        token: otherToken,
      },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "self-tests route: GET /api/v1/self-tests/:id 不存在返回 404",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/self-tests/st_nonexistent", {
      token: TEST_TOKEN,
    });
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "self-tests route: 超过每用户限流阈值返回 429",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    let lastStatus = 0;
    // 该用户在前面已创建过 1 次自测，这里再打 4 次应触发第 5 次 429
    for (let i = 0; i < 4; i++) {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${PROBLEM_ID}/self-test`,
        {
          method: "POST",
          body: { language: "python3", code: "print(1)" },
          token: TEST_TOKEN,
        },
      );
      lastStatus = res.status;
    }
    assertEquals(lastStatus, 429);
  },
});

Deno.test({
  name: "self-tests route: 清理测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(selfTests).where(eq(selfTests.problem_id, PROBLEM_ID));
    await db.delete(problems).where(eq(problems.id, PROBLEM_ID));
  },
});
