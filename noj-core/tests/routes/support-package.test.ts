/**
 * 支持包路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !hasDb;
const skipEnv = !hasEnv;

const ts = Date.now();
const TEST_PROBLEM_ID = `route-sp-problem-${ts}`;
const SOLUTION_ID = crypto.randomUUID();
const OWNER_ID = `route-sp-owner-${ts}`;

/**
 * 创建测试题目（直接 DB 插入）。
 */
async function createTestProblem(
  id: string = TEST_PROBLEM_ID,
  ownerId: string = OWNER_ID,
  type: string = "U",
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `支持包路由测试 ${ts}`,
    description: "测试描述",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: 9996,
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name:
    "support-package route: POST /problems/:id/support-package 所有者上传成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 构造 multipart/form-data
    const zipContent = new Uint8Array([
      0x50,
      0x4b,
      0x05,
      0x06,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const blob = new Blob([zipContent], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", blob, "test.zip");

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.support_package_path, "string");
  },
});

Deno.test({
  name:
    "support-package route: POST /problems/:id/support-package admin 上传成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

    const blob = new Blob([new Uint8Array(10)], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", blob, "admin.zip");

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "support-package route: POST 非 owner 返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: "other-user", role: "user" });

    const blob = new Blob([new Uint8Array(10)], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", blob, "test.zip");

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "support-package route: POST 非 zip 文件返回 400",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const blob = new Blob(["not a zip"], { type: "text/plain" });
    const formData = new FormData();
    formData.append("file", blob, "test.txt");

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "support-package route: POST 不存在的题目返回 404",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const blob = new Blob([new Uint8Array(10)], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", blob, "test.zip");

    const res = await app.request(
      "/api/v1/problems/nonexistent-id/support-package",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "support-package route: DELETE 删除成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 先上传
    const blob = new Blob([new Uint8Array(10)], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", blob, "test.zip");
    await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );

    // 再删除
    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.support_package_path, null);
  },
});

Deno.test({
  name: "support-package route: DELETE 不存在的支持包幂等返回 200",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "support-package route: DELETE 非 owner 返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();
    const token = await signToken({ sub: "other-user", role: "user" });

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "support-package route: 未登录返回 401",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);
    const app = createApp();

    const res = await app.request(
      `/api/v1/problems/${TEST_PROBLEM_ID}/support-package`,
      { method: "POST" },
    );
    assertEquals(res.status, 401);
  },
});

// 清理
Deno.test({
  name: "support-package route: cleanup",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, TEST_PROBLEM_ID));
    } catch {
      // ignore
    }
    try {
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, SOLUTION_ID));
    } catch {
      // ignore
    }
    // 清理文件
    try {
      const { getPackagePath } = await import(
        "../../src/services/support-package.ts"
      );
      await Deno.remove(getPackagePath(TEST_PROBLEM_ID));
    } catch {
      // ignore
    }
  },
});
