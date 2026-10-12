import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();
await initRedisForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasDb = true; // PGlite 内存数据库始终可用
const skip = !(hasEnv && hasDb);

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
      token: "invalid-token-here",
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 缺少字段返回 400",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: { problem_id: "1001" }, // 缺少 language 和 code
      token,
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("缺少必填字段"), true);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions/:id 无 token 返回 404",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    // GET /:id 路由使用 optionalAuthMiddleware：无 token 时不抛 401，
    // 由 service 层对不存在的 id 抛 NotFoundError → 404
    const res = await jsonRequest(app, "/api/v1/submissions/123");
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id 有效 token 但提交不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions/nonexistent-id", {
      token,
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});

// ── 提交列表 ──

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      token: "invalid-token",
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 无数据时返回空列表和分页信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    // 认证中间件会实时校验账号状态，测试令牌必须对应真实活跃用户。
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions", { token });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.data.length, 0);
    assertExists(body.pagination);
    assertEquals(body.pagination.page, 1);
    assertEquals(body.pagination.per_page, 20);
    assertEquals(body.pagination.total, 0);
    assertEquals(body.pagination.total_pages, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 按 status 筛选返回错误状态值时 400",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions?status=invalid", {
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions per_page 超过上限自动限制",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions?per_page=999", {
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.pagination.per_page, 100);
  },
});

// ── 管理员提交列表 ──

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 普通用户返回 403",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions", {
      token,
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "需要管理员权限");
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 管理员查看所有提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions", {
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertExists(body.pagination);
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 按 user_id 筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/submission/submissions?user_id=nonexistent-user",
      { token },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.length, 0);
    assertEquals(body.pagination.total, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id/status 提交不存在时返回 404 + code + request_id",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id/status",
      { token },
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
    assertEquals(body.code, "NOT_FOUND");
    assertExists(body.request_id);
  },
});

Deno.test({
  name: "submissions route: 版本/有效性/可升级筛选与非法参数校验",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const problemId = crypto.randomUUID();
    const v1 = `${problemId}-v1`;
    const v2 = `${problemId}-v2`;

    await db.insert(users).values({
      id: userId,
      username: `sub-filter-${Date.now()}`,
      email: `${userId}@test.local`,
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: problemId,
      title: "筛选测试题",
      description: "d",
      type: "P",
      number: 988000 + (Date.now() % 1000),
      owner_id: "0",
      difficulty: "easy",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values([
      {
        id: v1,
        problem_id: problemId,
        version: 1,
        origin: "published",
        content: { kind: "ai", title: "筛选测试题" },
        published_at: now,
      },
      {
        id: v2,
        problem_id: problemId,
        version: 2,
        origin: "published",
        content: { kind: "ai", title: "筛选测试题" },
        published_at: now,
      },
    ]);
    await db.update(problems).set({ latest_version_id: v2 }).where(
      eq(problems.id, problemId),
    );
    await db.insert(submissions).values([
      {
        id: "filter-s-v1",
        user_id: userId,
        problem_id: problemId,
        language: "python3",
        code: "print(1)",
        submitted_version_id: v1,
        version_origin: "known",
        is_valid: true,
        is_accepted: true,
        created_at: now,
      },
      {
        id: "filter-s-v2",
        user_id: userId,
        problem_id: problemId,
        language: "python3",
        code: "print(2)",
        submitted_version_id: v2,
        version_origin: "known",
        created_at: now,
      },
    ]);

    const token = await signToken({ sub: userId, role: "user" });
    const idsOf = async (query: string): Promise<string[]> => {
      const res = await jsonRequest(
        app,
        `/api/v1/submissions?problem_id=${problemId}&${query}`,
        { token },
      );
      assertEquals(res.status, 200);
      return (await res.json()).data.map((item: { id: string }) => item.id);
    };

    assertEquals(await idsOf("upgradable=1"), ["filter-s-v1"]);
    assertEquals(
      await idsOf("version_origin=known").then((ids) => ids.sort()),
      [
        "filter-s-v1",
        "filter-s-v2",
      ],
    );
    assertEquals(await idsOf(`version_id=${v1}`), ["filter-s-v1"]);
    assertEquals(await idsOf("valid_only=1"), ["filter-s-v1"]);
    assertEquals(await idsOf("accepted_only=1"), ["filter-s-v1"]);

    // 非法版本来源属于客户端错误，必须 400 而不是静默忽略筛选
    const bad = await jsonRequest(
      app,
      `/api/v1/submissions?version_origin=bogus`,
      { token },
    );
    assertEquals(bad.status, 400);
  },
});
