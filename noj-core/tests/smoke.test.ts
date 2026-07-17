/**
 * 核心 API 冒烟测试（smoke test）。
 *
 * 快速验证核心 API 端点在 HTTP 层面的可达性和基础响应格式正确性。
 * 使用 PGlite 内存数据库，需要 REDIS_URL 可用（PR-1 后 authMiddleware
 * 校验 JWT 撤销状态依赖 Redis，fail-closed 设计）。
 * 作为 CI 中 core-smoke job 的快速反馈路径（预计 < 1 分钟完成）。
 *
 * 测试覆盖：
 * - GET /health — 健康检查
 * - POST /auth/register — 用户注册
 * - POST /auth/login — 用户登录
 * - GET /auth/me — 当前用户
 * - GET /problems — 题目列表
 * - GET /categories — 分类树
 * - 401 认证检查
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../src/app.ts";
import { resetDbForTest } from "../src/db/connection.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
} from "../src/services/system-settings.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../src/lib/env-snapshot.ts";

// 模块级：连接 Redis（PR-1 后 authMiddleware 需要 Redis 校验 JWT 撤销状态）
// 未配置 REDIS_URL 时跳过此步（依赖测试自身的 Redis fixture）
if (Deno.env.get("REDIS_URL")) {
  try {
    const redisModule = await import("../src/mq/connection.ts");
    redisModule.resetRedisForTest();
    await redisModule.connectRedis();
  } catch (e) {
    if (!String(e).includes("already connecting/connected")) {
      console.warn("[smoke] Redis 连接失败:", e);
    }
  }
}

// PGlite 模式：运行 DDL 建表。
if (!Deno.env.get("DATABASE_URL")) {
  await resetDbForTest();
}

// 初始化系统设置缓存 + env 快照，确保 DB-backed 设置项可正常读取。
_resetSystemSettingsForTest();
_resetEnvSnapshotForTest();
snapshotEnv();
await initSystemSettings();

// 禁用速率限制（避免无 Redis 时登录被限流/503）
Deno.env.set("RATE_LIMIT_ENABLED", "false");
// 设置测试 JWT_SECRET（CI 中通过 secret 注入，本地 PGlite 模式需默认值）
if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set("JWT_SECRET", "test-jwt-secret-for-smoke-test-min-32-chars!!");
}

const app = createApp();

// ── 健康检查 ──

Deno.test({
  name: "[smoke] GET /health 返回 200 + 服务状态",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/health");
    assertEquals(res.status, 200, "/health 应返回 200");
    const body = await res.json();
    assertEquals(body.service, "noj-core");
    assertExists(body.status);
    assertExists(body.database);
    console.log("  ✓ /health → " + body.status);
  },
});

// ── 用户注册/登录 ──

Deno.test({
  name: "[smoke] POST /auth/register 返回 201",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ts = Date.now().toString(36);
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "smoke_" + ts,
        email: "smoke_" + ts + "@test.com",
        password: "SmokeTestPass123",
      }),
    });
    assertEquals(res.status, 201, "注册应返回 201");
    console.log("  ✓ POST /auth/register → 201");
  },
});

Deno.test({
  name: "[smoke] POST /auth/login 返回 200 + token",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ts = Date.now().toString(36) + "b";
    // 先注册
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "smoke_b_" + ts,
        email: "smoke_b_" + ts + "@test.com",
        password: "SmokeTestPass123",
      }),
    });
    // 再登录
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: "smoke_b_" + ts + "@test.com",
        password: "SmokeTestPass123",
      }),
    });
    assertEquals(res.status, 200, "登录应返回 200");
    const body = await res.json();
    assertExists(body.data?.token, "登录响应应包含 token");
    console.log("  ✓ POST /auth/login → 200 + token");
  },
});

Deno.test({
  name: "[smoke] GET /auth/me 返回当前用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ts = Date.now().toString(36) + "c";
    // 注册并登录
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "smoke_c_" + ts,
        email: "smoke_c_" + ts + "@test.com",
        password: "SmokeTestPass123",
      }),
    });
    const loginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: "smoke_c_" + ts + "@test.com",
        password: "SmokeTestPass123",
      }),
    });
    const { data } = await loginRes.json() as { data: { token: string } };

    const res = await app.request("/api/v1/auth/me", {
      headers: { Authorization: "Bearer " + data.token },
    });
    assertEquals(res.status, 200, "/me 应返回 200");
    const me = await res.json();
    assertExists(me.data?.id, "/me 应返回 id");
    assertEquals(me.data?.email, "smoke_c_" + ts + "@test.com");
    console.log("  ✓ GET /auth/me → 200 (user:" + me.data?.username + ")");
  },
});

// ── 题目列表 ──

Deno.test({
  name: "[smoke] GET /problems 返回列表",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/api/v1/problems");
    assertEquals(res.status, 200, "题目列表应返回 200");
    const body = await res.json();
    assertExists(body.data, "响应应包含 data 字段");
    console.log("  ✓ GET /problems → 200 (" + body.data?.length + " 题)");
  },
});

// ── 分类树 ──

Deno.test({
  name: "[smoke] GET /categories 返回分类树",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/api/v1/categories");
    assertEquals(res.status, 200, "分类树应返回 200");
    const body = await res.json();
    assertExists(body.data, "响应应包含 data 字段");
    console.log("  ✓ GET /categories → 200");
  },
});

// ── 认证保护 ──

Deno.test({
  name: "[smoke] 未认证访问受保护端点返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/api/v1/submissions");
    assertEquals(res.status, 401, "未认证应返回 401");
    console.log("  ✓ 未认证 /submissions → 401");
  },
});
