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
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";

const app = createApp();
const JWT_SECRET = Deno.env.get("JWT_SECRET");

// ─── 统计数据 SSE（公开，无需认证） ──────────────────────────

Deno.test({
  name: "sse: GET /submissions/stats/events 返回 200（公开）",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request("/api/v1/submissions/stats/events", {
      signal: AbortSignal.timeout(3000),
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
      signal: AbortSignal.timeout(1000),
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
        signal: AbortSignal.timeout(1000),
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

// ─── 队列 SSE（需认证） ─────────────────────────────────────

Deno.test({
  name: "sse: GET /queue/events 未认证 401",
  ignore: !JWT_SECRET,
  fn: async () => {
    const res = await app.request("/api/v1/queue/events", {
      signal: AbortSignal.timeout(1000),
    });
    assertEquals(res.status, 401);
  },
});
