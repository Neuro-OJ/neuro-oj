import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { createProblem } from "../../src/services/problems.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !hasDb;
const skipEnv = !hasEnv;

// 创建测试题目供 PUT/DELETE 等需要已存在题目的测试使用
const ts = Date.now();
const TEST_PROBLEM_ID = `route-test-1001-${ts}`;

Deno.test({
  name: "problems route: 初始化测试题目",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: TEST_PROBLEM_ID,
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      number: 9998,
      owner_id: "0",
      type: "U",
      created_at: now,
      updated_at: now,
    });
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems 返回分页列表",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(typeof body.total, "number");
    assertEquals(typeof body.page, "number");
    assertEquals(typeof body.limit, "number");
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems 支持分页参数",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems?page=1&limit=5");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.page, 1);
    assertEquals(body.limit, 5);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems 按难度筛选",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems?difficulty=easy");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(
      body.data.every((i: { difficulty: string }) => i.difficulty === "easy"),
      true,
    );
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems 按关键词搜索",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems?keyword=舱门");
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems/:id 返回题目详情含分类",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    // 先创建一个带分类的题目，确保数据存在
    await resetDbForTest();
    const ts = Date.now();
    const catId = `route-test-cat-${ts}`;
    const db = getDb();
    const { categories } = await import("../../src/db/schema.ts");
    const now = new Date().toISOString();
    await db.insert(categories).values({
      id: catId,
      name: "测试分类",
      slug: `route-test-cat-${ts}`,
      description: "",
      parent_id: null,
      level: 0,
      created_at: now,
      updated_at: now,
    });
    const problem = await createProblem({
      title: "路由测试题目",
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      category_ids: [catId],
    });
    const res = await app.request(`/api/v1/problems/${problem.id}`);
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.data.id, problem.id);
    assertEquals(Array.isArray(body.data.categories), true);
    assertEquals(body.data.categories.length, 1);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems/:id 不存在的题目返回 404",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems/nonexistent");
    assertEquals(res.status, 404);

    const body = await res.json();
    assertEquals(body.error, "题目不存在");
  },
});

Deno.test({
  name: "problems route: POST /api/v1/problems 未登录返回 401",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新题" }),
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "problems route: POST /api/v1/problems 非管理员创建 P 型返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });

    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "新题",
        description: "描述",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        type: "P",
      }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "problems route: POST /api/v1/problems 管理员创建成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "管理员创建的新题",
        description: "测试描述",
        difficulty: "medium",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 256,
      }),
    });
    assertEquals(res.status, 201);

    const body = await res.json();
    assertEquals(body.data.title, "管理员创建的新题");
  },
});

Deno.test({
  name: "problems route: PUT /api/v1/problems/:id 非管理员返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });

    const res = await app.request(`/api/v1/problems/${TEST_PROBLEM_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "被篡改" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "problems route: DELETE /api/v1/problems/:id 非管理员返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });

    const res = await app.request(`/api/v1/problems/${TEST_PROBLEM_ID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "problems route: XSS 防护 — 响应格式为 JSON",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/problems");
    assertEquals(
      res.headers.get("content-type")?.includes("application/json"),
      true,
    );
  },
});

// ── issue #66: judge_type 路由层测试 ──

Deno.test({
  name: "problems route: 列表返回 judge_type 字段",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createProblem({
      title: `路由层 judge_type ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      judge_type: "standard",
    });
    const app = createApp();
    const res = await app.request("/api/v1/problems");
    const body = await res.json();
    const created = body.data.find((p: { title: string }) =>
      p.title.includes(`路由层 judge_type ${ts}`)
    );
    assertEquals(!!created, true);
    assertEquals(created.judge_type, "standard");
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems/:id 详情含 judge_type",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await createProblem({
      title: `详情 judge_type ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      judge_type: "standard",
    });
    const app = createApp();
    const res = await app.request(`/api/v1/problems/${problem.id}`);
    const body = await res.json();
    assertEquals(body.data.judge_type, "standard");
  },
});

Deno.test({
  name: "problems route: POST 非法 judge_type 返回 400",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "非法 judge_type",
        description: "测试",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        judge_type: "bogus",
      }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems?judge_type=standard 过滤",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createProblem({
      title: `过滤 standard ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      judge_type: "standard",
    });
    const app = createApp();
    const res = await app.request("/api/v1/problems?judge_type=standard");
    const body = await res.json();
    assertEquals(
      body.data.every((p: { judge_type: string }) =>
        p.judge_type === "standard"
      ),
      true,
    );
  },
});
