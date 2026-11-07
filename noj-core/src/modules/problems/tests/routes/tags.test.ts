import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import {
  createUserToken,
  deleteProblemFixtures,
  jsonRequest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems, problemTags, tags } from "../../../../shared/db/schema.ts";

// 模块级 bootstrap：确保表已创建（测试数据库 模式）
await resetDbForTest();
await initRedisForTest();

const ts = Date.now();

Deno.test({
  name: "tags route: GET /api/v1/tags 返回标签列表（含 problem_count）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/tags");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    for (const item of body.data) {
      assertEquals(typeof item.id, "string");
      assertEquals(typeof item.name, "string");
      assertEquals(typeof item.kind, "string");
      assertEquals(typeof item.problem_count, "number");
    }
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags 未登录返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: "新标签", kind: "problem" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "tags route: POST /api/v1/tags 默认用户返回 403（tag:manage 默认仅 admin）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: `测试标签-${ts}`, kind: "problem" },
      token,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags admin 创建成功 201",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const name = `测试标签-${ts}`;

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name, kind: "algorithm" },
      token,
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.name, name);
    assertEquals(body.data.kind, "algorithm");

    // 清理
    const db = getDb();
    await db.delete(tags).where(eq(tags.name, name));
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags 非法 kind 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: `非法标签-${ts}`, kind: "unknown" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "tags route: DELETE /api/v1/tags 不存在的标签返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags/nonexistent-id", {
      method: "DELETE",
      token,
    });
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "tags route: merge 缺少 target_id 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags/nonexistent/merge", {
      method: "POST",
      body: {},
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "tags route: 题目按标签筛选命中",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const adminToken = await createUserToken("admin");

    // 创建标签 + 题目 + 关联
    const tagName = `筛选题标签-${ts}`;
    const tagRes = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: tagName, kind: "problem" },
      token: adminToken,
    });
    assertEquals(tagRes.status, 201);
    const tagId = (await tagRes.json()).data.id;

    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      domain_id: "00000000-0000-4000-8000-000000000001",
      id: problemId,
      title: `筛选测试题-${ts}`,
      description: "描述",
      difficulty: "easy",
      visibility: "public",
      runtime_config: null,
      is_objective: false,
      number: 900000 + (ts % 10000),
      owner_id: "0",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemTags).values({
      problem_id: problemId,
      tag_id: tagId,
    });
    // 公共列表只含已发布题目（Handbook §6.2）：补基线版本
    await publishBaselineVersionForTest(problemId);

    // 按标签筛选命中
    const res = await jsonRequest(app, `/api/v1/problems?tag=${tagId}`);
    assertEquals(res.status, 200);
    const body = await res.json();
    const ids = (body.data as { id: string }[]).map((p) => p.id);
    assertEquals(ids.includes(problemId), true);
    // 列表项只含题目标签
    const items = body.data as Array<{ id: string; tags: { kind: string }[] }>;
    const item = items.find((p) => p.id === problemId);
    assertEquals(item !== undefined, true);
    if (item) {
      for (const t of item.tags) {
        assertEquals(t.kind, "problem");
      }
    }

    // 清理
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await deleteProblemFixtures(eq(problems.id, problemId));
    await db.delete(tags).where(eq(tags.id, tagId));
  },
});

import { resetDbForTest } from "../default-fixture.ts";
