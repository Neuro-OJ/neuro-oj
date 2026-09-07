import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { createProblem } from "../../index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";

// PGlite 内存数据库始终可用
const dbAvailable = true;
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !dbAvailable;
const skipEnv = !hasEnv;

const ts = Date.now();

// 模块级 setup：创建跨测试共享的测试题目
await resetDbForTest();
await initRedisForTest();
const MODULE_PROBLEM = await createProblem({
  title: `模块级测试题目 ${ts}`,
  description: "测试描述",
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
});
const TEST_PROBLEM_ID = MODULE_PROBLEM.id;

/** 创建测试题目并可按需写入可见性/支持包 URL（模拟服务端私有题）。 */
async function createProblemForTest(opts: {
  type?: string;
  visibility?: "public" | "private";
  support_package_storage_url?: string;
  is_objective?: boolean;
} = {}): Promise<{ id: string; owner_id: string }> {
  const created = await createProblem({
    title: `路由可见性测试题 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    description: "测试描述",
    difficulty: "easy",
    type: opts.type ?? "U",
    is_objective: opts.is_objective === true,
    ...(opts.is_objective === true ? {} : {
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
    }),
  });
  const db = getDb();
  const updates: Partial<typeof problems.$inferSelect> = {};
  if (opts.visibility) updates.visibility = opts.visibility;
  if (opts.support_package_storage_url) {
    updates.support_package_storage_url = opts.support_package_storage_url;
  }
  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    await db.update(problems).set(updates).where(eq(problems.id, created.id));
  }
  return { id: created.id, owner_id: created.owner_id };
}

Deno.test({
  name: "problems route: GET /api/v1/problems 返回分页列表",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/problems");
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
    const res = await jsonRequest(app, "/api/v1/problems?page=1&limit=5");
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
    const res = await jsonRequest(app, "/api/v1/problems?difficulty=easy");
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
    const res = await jsonRequest(
      app,
      "/api/v1/problems?keyword=" + encodeURIComponent("测试"),
    );
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
    const catId = `route-test-tag-${Date.now()}`;
    const db = getDb();
    const { tags } = await import("../../../../shared/db/schema.ts");
    const now = new Date().toISOString();
    await db.insert(tags).values({
      id: catId,
      name: `路由测试标签-${Date.now()}`,
      kind: "problem",
      created_at: now,
      updated_at: now,
    });
    const problem = await createProblem({
      title: "路由测试题目",
      description: "测试描述",
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
      tag_ids: [catId],
    });
    // 新建 U 型默认 private；本用例验证公开详情/标签，需转 public
    await db.update(problems).set({
      visibility: "public",
      updated_at: new Date().toISOString(),
    }).where(eq(problems.id, problem.id));
    const res = await jsonRequest(app, `/api/v1/problems/${problem.id}`);
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.data.id, problem.id);
    assertEquals(Array.isArray(body.data.tags), true);
    assertEquals(body.data.tags.length, 1);
  },
});

Deno.test({
  name: "problems route: GET /api/v1/problems/:id 不存在的题目返回 404",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/problems/nonexistent");
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
    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      body: { title: "新题" },
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
    const token = await createUserToken();

    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      body: {
        title: "新题",
        description: "描述",
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
        type: "P",
      },
      token,
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
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      body: {
        title: "管理员创建的新题",
        description: "测试描述",
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
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
      token,
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
    const token = await createUserToken();

    const res = await jsonRequest(app, `/api/v1/problems/${TEST_PROBLEM_ID}`, {
      method: "PUT",
      body: { title: "被篡改" },
      token,
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
    const token = await createUserToken();

    const res = await jsonRequest(app, `/api/v1/problems/${TEST_PROBLEM_ID}`, {
      method: "DELETE",
      token,
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
    const res = await jsonRequest(app, "/api/v1/problems");
    assertEquals(
      res.headers.get("content-type")?.includes("application/json"),
      true,
    );
  },
});

Deno.test({
  name: "problems route: 匿名读取 private U 题返回 404",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = await createProblemForTest({ type: "U", visibility: "private" });
    const app = createApp();
    const res = await jsonRequest(app, `/api/v1/problems/${p.id}`);
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "problems route: 非 owner 读取 public 题不含 storage/runtime/llm 字段",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = await createProblemForTest({
      type: "U",
      visibility: "public",
      support_package_storage_url: "noj-storage://local/secret",
    });
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, `/api/v1/problems/${p.id}`, { token });
    assertEquals(res.status, 200);
    const data = (await res.json()).data;
    assertEquals(data.support_package_storage_url, undefined);
    assertEquals(data.runtime_config, undefined);
    assertEquals(data.llm_config, undefined);
    assertEquals(data.visibility, "public");
  },
});

Deno.test({
  name: "problems route: 非 owner 匿名读取 public 题同样不返回敏感字段",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = await createProblemForTest({ type: "U", visibility: "public" });
    const app = createApp();
    const res = await jsonRequest(app, `/api/v1/problems/${p.id}`);
    assertEquals(res.status, 200);
    const data = (await res.json()).data;
    assertEquals(data.support_package_storage_url, undefined);
    assertEquals(data.runtime_config, undefined);
    assertEquals(data.llm_config, undefined);
  },
});

Deno.test({
  name: "problems route: 匿名读取 private 套卷 questions 返回 404",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = await createProblemForTest({
      type: "U",
      visibility: "private",
      is_objective: true,
    });
    const app = createApp();
    const res = await jsonRequest(app, `/api/v1/problems/${p.id}/questions`);
    assertEquals(res.status, 404);
  },
});
