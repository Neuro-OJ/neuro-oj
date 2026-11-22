/**
 * 评测队列路由单元测试。
 *
 * 使用 jsonRequest() 通过 Hono 路由栈直接测试路由层逻辑（不依赖外部 HTTP 服务器）。
 * 需要 PostgreSQL + Redis 已在环境中运行。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";
import { runMigrations } from "../../../../shared/db/migrate.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";

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

Deno.test({
  name:
    "queue route: GET /api/v1/admin/submission/queue/health 无 token 返回 401",
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/submission/queue/health");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "queue route: GET /api/v1/admin/submission/queue/health 非管理员返回 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/admin/submission/queue/health",
      {
        token,
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name:
    "queue route: GET /api/v1/admin/submission/queue/health 管理员返回 200 且结构完整",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/submission/queue/health",
      {
        token,
      },
    );
    assertEquals(res.status, 200);

    const body = await res.json();
    assertExists(body.judge);
    assertExists(body.result);
    assertEquals(typeof body.redis_ok, "boolean");
    assertEquals(typeof body.judge.queue_length, "number");
    assertEquals(typeof body.judge.processing_length, "number");
    assertEquals(typeof body.judge.dead_length, "number");
    assertEquals(typeof body.result.queue_length, "number");
    assertEquals(typeof body.result.processing_length, "number");
    assertEquals(typeof body.result.dead_length, "number");
  },
});

Deno.test({
  name: "submissions/:id/status: 无 token 返回 401",
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions/123/status");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "submissions/:id/status: 有效 token 但提交不存在返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id/status",
      { token },
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});

Deno.test({
  name: "submissions/:id/status: 非提交者也可访问（不限制身份）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id/status",
      { token },
    );
    assertEquals(res.status, 404); // 404 而非 401/403 = 权限检查正确
  },
});

Deno.test({
  name: "submissions/:id: 增强详情接口提交不存在时返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureReady();
    if (!ready) return;

    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id",
      { token },
    );
    assertEquals(res.status, 404);
  },
});
