import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, submissions, users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

const ts = Date.now();

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/users/some-id/role", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 管理员提升用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    // 目标用户存在时会成功，不存在时返回 404
    // 这里只验证鉴权通过，具体业务由服务层测试覆盖
    assertEquals(
      [200, 404].includes(res.status),
      true,
    );
  },
});

Deno.test({
  name: "admin route: PATCH /api/v1/admin/users/:id/role 非法角色值返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "superuser" }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name:
    "admin route: PATCH /api/v1/admin/users/:id/role 缺少 role 字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });

    const res = await app.request("/api/v1/admin/users/target-id/role", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  },
});

// ─── 仪表盘统计 ──────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/dashboard/stats");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/dashboard/stats 管理员可访问",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.total_users, "number");
    assertEquals(typeof body.data.total_problems, "number");
    assertEquals(typeof body.data.total_submissions, "number");
  },
});

// ─── 题目列表 ────────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/problems 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/problems", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/problems 管理员可访问",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/problems", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(typeof body.total, "number");
  },
});

// ─── 提交详情 ────────────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/submissions/:id 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/admin/submissions/some-id");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/submissions/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/submissions/some-id", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: DELETE /api/v1/admin/submissions/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/submissions/some-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

// ─── 用户编辑 ───────────────────────────────────────────

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 非管理员返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bio: "新简介" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 无字段返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 邮箱格式非法返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/some-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assertEquals(res.status, 400);
  },
});

// ─── 用户搜索筛选 ──────────────────────────────────────

Deno.test({
  name: "admin route: GET /api/v1/admin/users 支持 keyword 参数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/users?keyword=admin",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/users 支持 role 参数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/users?role=admin",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

// ─── 功能性测试（issue #71 review）──────────────────────────

/** 在 DB 中直接插入一个测试用户（绕过 register 路由以便复用现成字段） */
async function insertTestUser(
  username: string,
  email: string,
  bio = "",
): Promise<string> {
  const db = getDb();
  const id = `adm-${username}`;
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username,
    email,
    password_hash: "x",
    role: "user",
    bio,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function cleanupTestUser(id: string) {
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.id, id));
  } catch {
    // ignore
  }
}

async function cleanupTestSubmission(id: string) {
  try {
    const db = getDb();
    await db.delete(submissions).where(eq(submissions.id, id));
  } catch {
    // ignore
  }
}

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 成功更新 bio",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const username = `adm_bio_${ts}`;
    const targetId = await insertTestUser(username, `${username}@example.com`);

    try {
      const token = await signToken({ sub: "admin-user", role: "admin" });
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ bio: "管理员更新的简介" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.bio, "管理员更新的简介");

      // 验证 DB 中已更新
      const db = getDb();
      const rows = await db
        .select({ bio: users.bio })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      assertEquals(rows[0]?.bio, "管理员更新的简介");
    } finally {
      await cleanupTestUser(targetId);
    }
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 邮箱冲突返回 409",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const userA = `adm_email_a_${ts}`;
    const userB = `adm_email_b_${ts}`;
    const emailA = `adm_email_a_${ts}@example.com`;
    const emailB = `adm_email_b_${ts}@example.com`;
    const idA = await insertTestUser(userA, emailA);
    const idB = await insertTestUser(userB, emailB);

    try {
      const token = await signToken({ sub: "admin-user", role: "admin" });
      // 试图把 B 的邮箱改成 A 的，应 409
      const res = await app.request(`/api/v1/admin/users/${idB}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: emailA }),
      });
      assertEquals(res.status, 409);
    } finally {
      await cleanupTestUser(idA);
      await cleanupTestUser(idB);
    }
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 不存在用户返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/nonexistent-user-id", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bio: "不存在" }),
    });
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/0 拒绝修改 root",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/admin/users/0", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bio: "试图改 root" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin route: PUT /api/v1/admin/users/:id 强化邮箱正则拒绝 TLD 1 字符",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const username = `adm_tld_${ts}`;
    const targetId = await insertTestUser(username, `${username}@example.com`);

    try {
      const token = await signToken({ sub: "admin-user", role: "admin" });
      // "a@b.c" TLD 只有 1 字符 → 应被强化正则拒绝
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: "weak@example.c" }),
      });
      assertEquals(res.status, 400);
    } finally {
      await cleanupTestUser(targetId);
    }
  },
});

Deno.test({
  name: "admin route: GET /api/v1/admin/users keyword 实际筛选命中",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const uniq = `kwfilter_${ts}`;
    const username = `${uniq}_user`;
    const targetId = await insertTestUser(username, `${uniq}@example.com`);

    try {
      const token = await signToken({ sub: "admin-user", role: "admin" });
      const res = await app.request(
        `/api/v1/admin/users?keyword=${uniq}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      // 至少包含新建的测试用户
      const ids = body.data.map((u: { id: string }) => u.id);
      assertEquals(ids.includes(targetId), true);
    } finally {
      await cleanupTestUser(targetId);
    }
  },
});

Deno.test({
  name: "admin route: DELETE /api/v1/admin/submissions/:id 管理员真删除",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const db = getDb();

    // 需要测试用户（FK）和测试题目（FK）—— 通过 createSubmission 复用
    const { problems } = await import("../../src/db/schema.ts");
    const userId = `adm-del-user-${ts}`;
    const problemId = `adm-del-prob-${ts}`;
    const submissionId = `adm-del-sub-${ts}`;
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: userId,
      username: userId,
      email: `${userId}@example.com`,
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: problemId,
      title: `del-test-${ts}`,
      description: "x",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      owner_id: userId,
      type: "U",
      number: 70000 + (ts & 0x7fff),
      created_at: now,
      updated_at: now,
    });

    // 直接插 DB 提交行（避免 createSubmission 触发 Redis MQ）
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      language: "python3",
      code: "print('hi')",
      file_name: "main.py",
      status: "pending",
      created_at: now,
    });

    try {
      const token = await signToken({ sub: "admin-user", role: "admin" });
      const res = await app.request(
        `/api/v1/admin/submissions/${submissionId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      assertEquals(res.status, 204);

      // 验证 DB 中已删除
      const rows = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);
      assertEquals(rows.length, 0);
    } finally {
      await cleanupTestSubmission(submissionId);
      await cleanupTestUser(userId);
      await db.delete(problems).where(eq(problems.id, problemId));
    }
  },
});

Deno.test({
  name: "admin route: DELETE /api/v1/admin/submissions/:missing-id 返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 404);
  },
});

// ─── 重测 API ────────────────────────────────────────────

Deno.test({
  name:
    "admin route: POST /api/v1/admin/submissions/:id/rejudge 未登录返回 401",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request(
      "/api/v1/admin/submissions/some-id/rejudge",
      { method: "POST" },
    );
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "admin route: POST /api/v1/admin/submissions/:id/rejudge 非管理员返回 403",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request(
      "/api/v1/admin/submissions/some-id/rejudge",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name:
    "admin route: POST /api/v1/admin/submissions/:id/rejudge 不存在的提交返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000/rejudge",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "admin route: POST /api/v1/admin/problems/:id/rejudge 未登录返回 401",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request(
      "/api/v1/admin/problems/some-id/rejudge",
      { method: "POST" },
    );
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin route: POST /api/v1/admin/problems/:id/rejudge 非管理员返回 403",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "regular-user", role: "user" });
    const res = await app.request(
      "/api/v1/admin/problems/some-id/rejudge",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name:
    "admin route: POST /api/v1/admin/problems/:id/rejudge 不存在的题目返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/problems/00000000-0000-0000-0000-000000000000/rejudge",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 404);
  },
});

// ─── 重测业务路径 ─────────────────────────────────────

Deno.test({
  name: "admin route: POST /api/v1/admin/problems/:id/rejudge 有活跃提交时拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const now = new Date().toISOString();
    const ts = Date.now();

    const problemId = `rej-test-problem-${ts}`;
    const testUserId = await insertTestUser(
      `rej-user-${ts}`,
      `rej-${ts}@test.noj`,
    );

    await db.insert(problems).values({
      id: problemId,
      title: `重测测试 ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      number: 80000 + (ts & 0x7fff),
      owner_id: "0",
      type: "P",
      created_at: now,
      updated_at: now,
    });

    const judgingSubId = `rej-sub-judging-${ts}`;
    await db.insert(submissions).values({
      id: judgingSubId,
      user_id: testUserId,
      problem_id: problemId,
      language: "python3",
      code: "print(1)",
      status: "judging",
      judge_started_at: now,
      created_at: now,
    });

    const res = await app.request(
      `/api/v1/admin/problems/${problemId}/rejudge`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("活跃评测"), true);

    await db.delete(submissions).where(eq(submissions.id, judgingSubId));
    await db.delete(problems).where(eq(problems.id, problemId));
  },
});

Deno.test({
  name:
    "admin route: POST /api/v1/admin/problems/:id/rejudge 无已完结提交返回空",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const now = new Date().toISOString();
    const ts = Date.now();

    const problemId = `rej-empty-${ts}`;
    await db.insert(problems).values({
      id: problemId,
      title: `重测空 ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      number: 85000 + (ts & 0x7fff),
      owner_id: "0",
      type: "P",
      created_at: now,
      updated_at: now,
    });

    const res = await app.request(
      `/api/v1/admin/problems/${problemId}/rejudge`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 0);
    assertEquals(body.queued, 0);
    assertEquals(body.skipped, 0);

    await db.delete(problems).where(eq(problems.id, problemId));
  },
});
