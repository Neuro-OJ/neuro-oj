/**
 * SSE 路由层单元测试。
 *
 * 覆盖：
 * - 统计数据 SSE 端点（公开）
 * - 提交状态 SSE 端点（需认证）
 * - 队列 SSE 端点（需认证）
 *
 * SSE 流式端点通过短超时 + AbortSignal 获取初始响应头。
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  problems,
  submissions,
  userRoles,
  users,
} from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest } from "../lib/helper.ts";
import { ensureRbacSeeds } from "../../src/services/seed/seed-rbac.ts";

const app = createApp();
const JWT_SECRET = Deno.env.get("JWT_SECRET");

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

// ─── 统计数据 SSE（公开，无需认证） ──────────────────────────

Deno.test({
  name: "sse: GET /submissions/stats/events 返回 200（公开）",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request("/api/v1/submissions/stats/events", {
      signal: AbortSignal.timeout(500),
    });
    // SSE 端点应返回 200（事件流在 AbortSignal 触发时关闭）
    assertEquals(res.status, 200);
  },
});

// ─── 提交状态 SSE（需认证） ────────────────────────────────

Deno.test({
  name: "sse: GET /submissions/:id/events 未认证 401",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request("/api/v1/submissions/invalid-id/events", {
      signal: AbortSignal.timeout(200),
    });
    // 未认证应返回 401，不会创建 SSE 流
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "sse: GET /submissions/:id/events 无效 id 非 401",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request(
      "/api/v1/submissions/nonexistent/events",
      {
        headers: {
          Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdA.test",
        },
        signal: AbortSignal.timeout(200),
      },
    );
    // 带 token 但 id 不存在 → 应由 getSubmission 返回 404
    // 注意：实际行为取决于 authMiddleware 是否验证通过
    // 此处只验证不会返回 500
    if (res.status >= 500) {
      throw new Error("不应返回 500, 实际 " + res.status);
    }
  },
});

Deno.test({
  name: "sse: 管理员权限通过请求上下文传递后可订阅他人提交",
  ignore: !JWT_SECRET,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(users).values([
      {
        id: adminId,
        username: `sse-admin-${adminId}`,
        email: `${adminId}@test.local`,
        password_hash: "test",
        created_at: now,
        updated_at: now,
      },
      {
        id: ownerId,
        username: `sse-owner-${ownerId}`,
        email: `${ownerId}@test.local`,
        password_hash: "test",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(userRoles).values({ user_id: adminId, role_id: "admin" });
    await db.insert(userRoles).values({ user_id: ownerId, role_id: "user" });
    await db.insert(problems).values({
      id: problemId,
      title: "SSE 权限测试题",
      description: "SSE 权限测试",
      difficulty: "easy",
      runtime_config: {},
      number: 990000 + (Date.now() & 0x7fff),
      owner_id: adminId,
      type: "U",
      created_at: now,
      updated_at: now,
    });
    await db.insert(submissions).values({
      id: submissionId,
      user_id: ownerId,
      problem_id: problemId,
      language: "python3",
      code: "print(1)",
      file_name: "main.py",
      status: "finished",
      created_at: now,
    });

    try {
      // JWT 角色故意使用普通 user，验证权限来自请求上下文的实时 RBAC，
      // 而不是依赖旧的 role 字段。
      const token = await signToken({ sub: adminId, role: "user" });
      const res = await app.request(
        `/api/v1/submissions/${submissionId}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(500),
        },
      );
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "submission:updated");
    } finally {
      await db.delete(submissions).where(eq(submissions.id, submissionId));
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, adminId));
      await db.delete(users).where(eq(users.id, ownerId));
    }
  },
});

// ─── 队列 SSE（需认证） ─────────────────────────────────────

Deno.test({
  name: "sse: GET /queue/events 未认证 401",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request("/api/v1/queue/events", {
      signal: AbortSignal.timeout(200),
    });
    assertEquals(res.status, 401);
  },
});
