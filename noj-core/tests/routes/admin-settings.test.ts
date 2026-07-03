/**
 * 系统设置路由层测试（issue #99）。
 *
 * 覆盖场景：
 * - 401 未登录访问
 * - 403 非管理员访问
 * - 200 admin 列出全部设置
 * - PUT 更新设置（合法/类型错/未注册 key）
 * - DELETE 重置设置
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
} from "../../src/services/system-settings.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../src/lib/env-snapshot.ts";

const ts = Date.now();

// 测试需要 JWT_SECRET 签发 token
if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set(
    "JWT_SECRET",
    "test-secret-must-be-at-least-32-characters-long-xxx",
  );
}

async function freshSetup() {
  await resetDbForTest();
  _resetSystemSettingsForTest();
  _resetEnvSnapshotForTest();
  snapshotEnv();
  await initSystemSettings();
}

Deno.test({
  name: "admin-settings route: GET /settings 无 token 返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const res = await app.request("/api/v1/admin/settings");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "admin-settings route: GET /settings 普通用户返回 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await app.request("/api/v1/admin/settings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin-settings route: GET /settings admin 返回 200 + data 数组",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request("/api/v1/admin/settings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    // 至少 5 个 DB-backed 设置项
    const dbKeys = body.data
      .map((d: { key: string }) => d.key)
      .filter((k: string) =>
        [
          "allow_register",
          "smtp_from",
          "rate_limit_login_enabled",
          "maintenance_mode",
          "homepage_banner",
        ].includes(k)
      );
    assertEquals(dbKeys.length, 5);
  },
});

Deno.test({
  name: "admin-settings route: PUT /settings/:key admin 合法 boolean 写入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      `/api/v1/admin/settings/maintenance_mode_${ts}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: true }),
      },
    );
    // 用了 ts 后缀未注册，会 400。这里验证未注册 key 拒绝。
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: PUT /settings/allow_register admin 合法值",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: false }),
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.source, "db");
    assertEquals(body.data.effective_value, false);

    // 清理：恢复成 true
    await app.request(
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: true }),
      },
    );
  },
});

Deno.test({
  name: "admin-settings route: PUT 未注册 key 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/hacker_key",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: 1 }),
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: PUT 类型错返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: "yes" }),
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: PUT smtp_from email 格式错返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/smtp_from",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: "not-an-email" }),
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: DELETE /settings/:key admin 删除 DB 行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

    // 先写一个
    await app.request(
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: false }),
      },
    );

    // 再删
    const res = await app.request(
      "/api/v1/admin/settings/allow_register",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 204);

    // 验证后续 GET 不返回 404（DB 中已删，回退 default）
    const getRes = await app.request(
      "/api/v1/admin/settings/allow_register",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(getRes.status, 200);
  },
});

Deno.test({
  name: "admin-settings route: DELETE /settings/:key 不存在也返回 204（幂等）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/maintenance_mode",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 204);
  },
});

Deno.test({
  name: "admin-settings route: GET /settings/:key 存在返回 200",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await app.request(
      "/api/v1/admin/settings/allow_register",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.key, "allow_register");
  },
});
