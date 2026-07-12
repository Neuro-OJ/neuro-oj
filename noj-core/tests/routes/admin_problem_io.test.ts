/**
 * 题目导入导出路由测试（issue #28）。
 *
 * 覆盖 admin 端点的鉴权、参数校验、文件下载响应头、报告结构。
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { jsonRequest } from "../lib/helper.ts";
import { createProblem } from "../../src/services/problems.ts";
import { createCategory } from "../../src/services/categories.ts";

const ADMIN_ID = crypto.randomUUID();
const TEST_TS = Date.now();

async function freshSetup() {
  await resetDbForTest();
  const db = getDb();
  await db.delete(users).where(eq(users.id, ADMIN_ID));
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: ADMIN_ID,
    username: `io-admin-${TEST_TS}`,
    email: `io-admin-${TEST_TS}@noj.local`,
    password_hash: "x",
    role: "admin",
    created_at: now,
    updated_at: now,
  });
  // 准备一个分类（用 service 处理 created_at/updated_at）
  await createCategory({
    name: `导入测试分类-${TEST_TS}`,
    slug: `io-cat-${TEST_TS}`,
  });
}

async function adminToken(): Promise<string> {
  if (!Deno.env.get("JWT_SECRET")) {
    Deno.env.set(
      "JWT_SECRET",
      "test-secret-must-be-at-least-32-characters-long-xxx",
    );
  }
  return await signToken({ sub: ADMIN_ID, role: "admin" });
}

// ─── Export 端点 ───────────────────────────────────────────

Deno.test({
  name: "export route: 无 token → 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/export", {
      method: "POST",
      body: { type: "P" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "export route: 按 type=P 导出返 attachment 响应",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await createProblem(
      {
        title: `导出测试题-${TEST_TS}`,
        description: "## 样例输入\n\n1\n\n## 样例输出\n\n2\n",
        difficulty: "easy",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        type: "P",
      },
      ADMIN_ID,
      "admin",
    );

    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/export", {
      method: "POST",
      body: { type: "P" },
      token,
    });
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("Content-Type")?.startsWith("application/json"),
      true,
    );
    const disposition = res.headers.get("Content-Disposition") ?? "";
    assertEquals(disposition.includes("attachment"), true);
    assertEquals(disposition.includes(".json"), true);

    const body = await res.json();
    assertEquals(body.version, "1.0");
    assertEquals(body.exported_by, ADMIN_ID);
    assertEquals(Array.isArray(body.problems), true);
    assertEquals(body.problems.length >= 1, true);
    const found = body.problems.find(
      (p: { title: string }) => p.title === `导出测试题-${TEST_TS}`,
    );
    assertExists(found);
    assertEquals(found.samples.length, 1);
  },
});

Deno.test({
  name: "export route: ids 非法类型 → 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/export", {
      method: "POST",
      body: { ids: "not-array" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "export route: 非法 type → 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/export", {
      method: "POST",
      body: { type: "X" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

// ─── Import 端点 ───────────────────────────────────────────

Deno.test({
  name: "import route: 无 token → 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: { strategy: "create", payload: { version: "1.0", problems: [] } },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "import route: create 策略新建成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();

    const sourceId = crypto.randomUUID();
    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: {
        strategy: "create",
        payload: {
          version: "1.0",
          exported_at: new Date().toISOString(),
          exported_by: "test",
          problems: [
            {
              id: sourceId,
              display_id: "P9100",
              type: "P",
              number: 9100,
              title: `路由测试题-${TEST_TS}`,
              description: "无样例",
              difficulty: "easy",
              categories: [],
              judge_images: ["noj-judge-python"],
              judge_command: "python3 /tmp/evaluate.py",
              time_limit_ms: 1000,
              memory_limit_mb: 256,
              support_package_storage_url: null,
              test_cases_ref: null,
              samples: [],
            },
          ],
        },
      },
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.total, 1);
    assertEquals(body.data.created.length, 1);
    assertEquals(body.data.created[0].id, sourceId);
    assertEquals(body.data.failed.length, 0);
  },
});

Deno.test({
  name: "import route: 缺 strategy → 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: { payload: { version: "1.0", problems: [] } },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import route: 非法 strategy → 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: {
        strategy: "merge",
        payload: { version: "1.0", problems: [] },
      },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import route: overwrite 策略覆盖已存在题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // 先创建一道题
    const created = await createProblem(
      {
        title: `将被覆盖的题-${TEST_TS}`,
        description: "原始描述",
        difficulty: "easy",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        type: "P",
      },
      ADMIN_ID,
      "admin",
    );

    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();

    // 用同一 id 导入新描述
    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: {
        strategy: "overwrite",
        payload: {
          version: "1.0",
          exported_at: new Date().toISOString(),
          exported_by: "test",
          problems: [
            {
              id: created.id,
              display_id: `P${created.number}`,
              type: "P",
              number: created.number,
              title: `覆盖后的题-${TEST_TS}`,
              description: "新描述（覆盖后）",
              difficulty: "hard",
              categories: [],
              judge_images: ["noj-judge-python"],
              judge_command: "python3 /tmp/evaluate.py",
              time_limit_ms: 2000,
              memory_limit_mb: 512,
              support_package_storage_url: null,
              test_cases_ref: null,
              samples: [],
            },
          ],
        },
      },
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.updated.length, 1);
    assertEquals(body.data.updated[0].problem_id, created.id);

    // 验证 DB 已被覆盖
    const db = getDb();
    const row = await db.execute(
      `SELECT title, description, difficulty FROM problems WHERE id = '${created.id}'`,
    );
    const first = (row as unknown as {
      rows: { title: string; description: string; difficulty: string }[];
    }).rows[0];
    assertEquals(first?.title, `覆盖后的题-${TEST_TS}`);
    assertEquals(first?.description, "新描述（覆盖后）");
    assertEquals(first?.difficulty, "hard");
  },
});

Deno.test({
  name: "import route: skip 策略下已存在题被跳过",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const created = await createProblem(
      {
        title: `保留题-${TEST_TS}`,
        description: "原始",
        difficulty: "easy",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        type: "P",
      },
      ADMIN_ID,
      "admin",
    );

    const token = await adminToken();
    const { createApp } = await import("../../src/app.ts");
    const app = createApp();

    const res = await jsonRequest(app, "/api/v1/admin/problems/import", {
      method: "POST",
      body: {
        strategy: "skip",
        payload: {
          version: "1.0",
          exported_at: new Date().toISOString(),
          exported_by: "test",
          problems: [
            {
              id: created.id,
              display_id: `P${created.number}`,
              type: "P",
              number: created.number,
              title: "覆盖尝试（应被忽略）",
              description: "应不生效",
              difficulty: "hard",
              categories: [],
              judge_images: ["noj-judge-python"],
              judge_command: "python3 /tmp/evaluate.py",
              time_limit_ms: 2000,
              memory_limit_mb: 512,
              support_package_storage_url: null,
              test_cases_ref: null,
              samples: [],
            },
          ],
        },
      },
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.skipped.length, 1);
    assertEquals(body.data.created.length, 0);
    assertEquals(body.data.updated.length, 0);
  },
});
