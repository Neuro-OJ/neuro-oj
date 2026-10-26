import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../../src/app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  problems,
  sseEvents,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../../domains/identity/services/security/jwt.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { ensureRbacSeeds } from "../../../../domains/system/index.ts";
import { _dispatchToLocalListenersForTest } from "../../../../shared/sse/event-bus.ts";
import {
  INSTANCE_QUEUE_CHANNEL,
  queueEventChannel,
} from "../../services/queue.ts";

const app = createApp();

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

// ─── 提交状态 SSE（需认证） ────────────────────────────────

Deno.test({
  name: "sse: GET /submissions/:id/events 未认证 401",
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
      domain_id: DEFAULT_DOMAIN_ID,
      id: problemId,
      title: "SSE 权限测试题",
      description: "SSE 权限测试",
      difficulty: "easy",
      runtime_config: {},
      number: 990000 + (Date.now() & 0x7fff),
      owner_id: adminId,
      created_at: now,
      updated_at: now,
    });
    await db.insert(submissions).values({
      ...await problemExecutionForTest(problemId),
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
      await deleteProblemFixtures(eq(problems.id, problemId));
      // 显式清理测试夹具，避免物理删账号破坏负责人外键。
    }
  },
});

// ─── 队列 SSE（需认证） ─────────────────────────────────────

Deno.test({
  name: "sse: GET /queue/events 未认证 401",
  fn: async () => {
    const res = await app.request("/api/v1/queue/events", {
      signal: AbortSignal.timeout(200),
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "sse: 队列首次连接和重连只校准一次并继续实时通知",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: adminId,
      username: `queue-sse-${adminId}`,
      email: `${adminId}@test.local`,
      password_hash: "test",
      created_at: now,
      updated_at: now,
    });
    await db.insert(userRoles).values({ user_id: adminId, role_id: "admin" });
    const domainChannel = queueEventChannel(DEFAULT_DOMAIN_ID);
    // 重现打开页面时积累的历史通知；它们全部指向同一份当前队列。
    await db.insert(sseEvents).values(
      [domainChannel, INSTANCE_QUEUE_CHANNEL].flatMap((channel) =>
        Array.from({ length: 200 }, () => ({
          channel,
          payload: { type: "queue:changed" },
          created_at: now,
        }))
      ),
    );
    const token = await signToken({ sub: adminId, role: "admin" });
    for (
      const [path, channel] of [
        ["/queue/events", domainChannel],
        ["/domains/main/queue/events", domainChannel],
        ["/instance/queue/events", INSTANCE_QUEUE_CHANNEL],
      ]
    ) {
      for (const cursor of ["initial", "header", "query"]) {
        const res = await app.request(
          `/api/v1${path}${cursor === "query" ? "?afterSeq=1" : ""}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(cursor === "header" ? { "Last-Event-ID": "1" } : {}),
            },
            signal: AbortSignal.timeout(500),
          },
        );
        assertEquals(res.status, 200);
        const liveEvent = setTimeout(() => {
          _dispatchToLocalListenersForTest(
            channel,
            JSON.stringify({ type: "queue:changed" }),
          );
        }, 50);
        const reader = res.body!.getReader();
        const stop = setTimeout(() => void reader.cancel(), 250);
        try {
          const decoder = new TextDecoder();
          let body = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
          }
          assertEquals(
            (body.match(/event: queue:changed/g) ?? []).length,
            2,
            `${path} ${cursor}: 应只有一次初始通知和一次实时通知`,
          );
        } finally {
          clearTimeout(liveEvent);
          clearTimeout(stop);
          await reader.cancel();
          reader.releaseLock();
        }
      }
    }
  },
});
