import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !(hasEnv && hasDb);

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      }),
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token-here",
      },
      body: JSON.stringify({
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      }),
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 缺少字段返回 400",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request("/api/v1/submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ problem_id: "1001" }), // 缺少 language 和 code
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("缺少必填字段"), true);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions/:id 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/submissions/123");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id 有效 token 但提交不存在返回 404",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request("/api/v1/submissions/nonexistent-id", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});
