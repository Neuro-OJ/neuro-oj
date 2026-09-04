import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../../src/app.ts";

const app = createApp();
const JWT_SECRET = Deno.env.get("JWT_SECRET");

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
