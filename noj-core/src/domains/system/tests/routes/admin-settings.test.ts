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
import { eq } from "drizzle-orm";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
} from "../../index.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../services/env-snapshot.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";

// 测试需要 JWT_SECRET 签发 token
if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set(
    "JWT_SECRET",
    "test-secret-must-be-at-least-32-characters-long-xxx",
  );
}

async function freshSetup() {
  await resetDbForTest();
  await initRedisForTest();
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
    const res = await jsonRequest(app, "/api/v1/admin/settings");
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
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/admin/settings", { token });
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
    const token = await createUserToken("admin");
    const res = await jsonRequest(app, "/api/v1/admin/settings", { token });
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

    // 每条含 scope 元数据；runtime 与 bootstrap 两类都存在
    const allowRegister = body.data.find(
      (d: { key: string }) => d.key === "allow_register",
    );
    assertEquals(allowRegister?.scope, "runtime");
    const storageProvider = body.data.find(
      (d: { key: string }) => d.key === "storage_provider",
    );
    assertEquals(storageProvider?.scope, "bootstrap");
  },
});

Deno.test({
  name: "admin-settings route: PUT /settings/allow_register admin 合法值",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        body: { value: false },
        token,
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.source, "db");
    assertEquals(body.data.effective_value, false);

    // 清理：恢复成 true
    await jsonRequest(
      app,
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        body: { value: true },
        token,
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
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/hacker_key",
      {
        method: "PUT",
        body: { value: 1 },
        token,
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
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        body: { value: "yes" },
        token,
      },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: PUT bootstrap 键返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await createUserToken("admin");
    // email/storage 等划归 bootstrap 后不可经后台写
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/storage_provider",
      {
        method: "PUT",
        body: { value: "s3" },
        token,
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
    const token = await createUserToken("admin");

    // 先写一个
    await jsonRequest(
      app,
      "/api/v1/admin/settings/allow_register",
      {
        method: "PUT",
        body: { value: false },
        token,
      },
    );

    // 再删
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/allow_register",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 204);

    // 验证后续列表返回 default 来源（DB 中已删，回退 default）
    const listRes = await jsonRequest(app, "/api/v1/admin/settings", { token });
    assertEquals(listRes.status, 200);
    const listBody = await listRes.json();
    const item = listBody.data.find((i: { key: string }) =>
      i.key === "allow_register"
    );
    assertEquals(item.source, "default");
  },
});

Deno.test({
  name: "admin-settings route: DELETE /settings/:key DB 不存在也 204（幂等）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/maintenance_mode",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 204);
  },
});

Deno.test({
  name: "admin-settings route: DELETE bootstrap 键清理残留 DB 行 204",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();
    await db.insert(systemSettings).values({
      key: "email_provider",
      value: JSON.stringify("mock"),
      description: "测试残留",
      is_secret: false,
      updated_at: new Date().toISOString(),
      updated_by: "0",
    });
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/email_provider",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 204);
    // DB 行已清理
    const rows = await db.select().from(systemSettings).where(
      eq(systemSettings.key, "email_provider"),
    );
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "admin-settings route: DELETE /settings/:key 未注册 key 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await createUserToken("admin");
    // 安全约束：未注册 key（如内部标记 rbac_sensitive_field_permissions_seeded）
    // 不可经 reset 删除——否则收紧的敏感字段授权会在重启后被 seed 恢复
    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/totally_unregistered_key",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 400);
  },
});
