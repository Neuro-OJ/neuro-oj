/**
 * 支持包路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !hasDb;
const skipEnv = !hasEnv;

const ts = Date.now();
const SOLUTION_ID = crypto.randomUUID();
const OWNER_ID = `route-sp-owner-${ts}`;
const TEST_NUMBER = 60000 + (ts & 0x7fff);

/**
 * 每个测试独立的问题 ID 和引用变量。
 * problemIdRef[0] 始终指向当前测试创建的问题 ID，供 HTTP 请求使用。
 */
let problemSeq = 0;
const problemIdRef: string[] = [];

/**
 * 创建测试用户（确保 FK 约束满足）。
 */
async function createTestUser(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `rtuser-${id}`,
    email: `rtuser-${id}@test.com`,
    password_hash: "not-used",
    role: "user",
    created_at: now,
    updated_at: now,
  });
}

/**
 * 创建测试题目（直接 DB 插入）。每次调用使用独立 ID 避免 PK 冲突，
 * 并将 ID 存入 problemIdRef 供当前测试的 HTTP 请求使用。
 */
async function createTestProblem(
  ownerId: string = OWNER_ID,
  type: string = "U",
): Promise<string> {
  const db = getDb();
  const pid = `route-sp-problem-${ts}-${++problemSeq}`;
  problemIdRef[0] = pid;
  // 确保 owner 用户存在（FK 约束）
  if (ownerId !== "0") { // "0" 是 root 用户，无需创建
    const existingOwner = await db.select().from(users).where(
      eq(users.id, ownerId),
    ).limit(1);
    if (existingOwner.length === 0) {
      await createTestUser(ownerId);
    }
  }
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: pid,
    title: `支持包路由测试 ${ts}`,
    description: "测试描述",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: TEST_NUMBER + problemSeq, // +problemSeq 确保同文件内每个测试独立 number
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });
  return pid;
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
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

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
    formData.append("file", blob, "admin.zip");

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: "other-user", role: "user" });

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
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const blob = new Blob(["not a zip"], { type: "text/plain" });
    const formData = new FormData();
    formData.append("file", blob, "test.txt");

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 先上传
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
    await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );

    // 再删除
    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: "other-user", role: "user" });

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
    await createTestProblem();
    const app = createApp();

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
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
      // 清理本文件所有测试创建的问题（前缀匹配）
      await db.delete(problems).where(
        sql`${problems.id} LIKE 'route-sp-problem-%'`,
      );
      await db.delete(users).where(eq(users.id, OWNER_ID));
    } catch {
      // ignore
    }
    try {
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, SOLUTION_ID));
    } catch {
      // ignore
    }
    // 文件由问题删除时的级联清理处理，无需手动清理
  },
});
