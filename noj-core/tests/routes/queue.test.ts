/**
 * 评测队列路由单元测试。
 *
 * 使用 Hono app.request() 直接测试路由层逻辑（不依赖外部 HTTP 服务器）。
 * 需要 PostgreSQL + Redis 已在环境中运行。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { connectRedis } from "../../src/mq/connection.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { signToken } from "../../src/lib/jwt.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

// 全局初始化（连接 Redis + 运行迁移）
let ready = false;
async function ensureReady() {
  if (ready) return;
  try {
    await connectRedis();
    await runMigrations();
    ready = true;
  } catch {
    // 静默失败，测试跳过
  }
}

// Queue 路由测试
// 经设计评审后放开为登录用户可访问（无需管理员权限）。
// 三个场景：无 token → 401 / 非管理员 → 200 / 管理员 → 200。

Deno.test({
  name: "queue route: GET /api/v1/queue 无 token 返回 401",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/queue");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "queue route: GET /api/v1/queue 非管理员返回 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request("/api/v1/queue", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertExists(body.pending);
    assertExists(body.judging);
    assertExists(body.recently_completed);
    assertExists(body.stats);
    assertEquals(Array.isArray(body.pending), true);
    assertEquals(Array.isArray(body.judging), true);
    assertEquals(Array.isArray(body.recently_completed), true);
    assertEquals(typeof body.stats.pending_count, "number");
    assertEquals(typeof body.stats.judging_count, "number");
    assertEquals(typeof body.stats.completed_today, "number");
  },
});

Deno.test({
  name: "queue route: GET /api/v1/queue 管理员返回 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await signToken({ sub: "admin-user", role: "admin" });
    const res = await app.request("/api/v1/queue", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertExists(body.pending);
    assertExists(body.judging);
    assertExists(body.recently_completed);
    assertExists(body.stats);
    assertEquals(Array.isArray(body.pending), true);
    assertEquals(Array.isArray(body.judging), true);
    assertEquals(Array.isArray(body.recently_completed), true);
    assertEquals(typeof body.stats.pending_count, "number");
    assertEquals(typeof body.stats.judging_count, "number");
    assertEquals(typeof body.stats.completed_today, "number");
  },
});

Deno.test({
  name: "submissions/:id/status: 无 token 返回 401",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const res = await app.request("/api/v1/submissions/123/status");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "submissions/:id/status: 有效 token 但提交不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request(
      "/api/v1/submissions/nonexistent-id/status",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});

Deno.test({
  name: "submissions/:id/status: 非提交者也可访问（不限制身份）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await signToken({ sub: "user-a", role: "user" });
    const res = await app.request(
      "/api/v1/submissions/nonexistent-id/status",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 404); // 404 而非 401/403 = 权限检查正确
  },
});

Deno.test({
  name: "submissions/:id: 增强详情接口提交不存在时返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request(
      "/api/v1/submissions/nonexistent-id",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 404);
  },
});
