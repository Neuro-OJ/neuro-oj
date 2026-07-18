/**
 * PR-2 死开关 + auth 审计动作路由层测试。
 *
 * 覆盖：
 * - /register 在 allow_register=false 时返 403
 * - auth.login_success / auth.login_failure / auth.register / auth.change_password
 *   / auth.forgot_password_request / auth.password_reset 审计日志写入
 * - maintenance_mode=true 时 POST/PUT/PATCH/DELETE 返 503
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { auditLogs, users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  updateSetting,
} from "../../src/services/system-settings.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../src/lib/env-snapshot.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest, jsonRequest } from "../lib/helper.ts";

// PR-1：banlistMiddleware 走 Redis，避免 Redis 不可用时返 503
await initRedisForTest();

await resetDbForTest();

const hasDb = true;
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(hasDb && hasJwt);

// 必须先初始化系统设置（default 值入库），PR-2 修改才生效
snapshotEnv();
_resetSystemSettingsForTest();
await initSystemSettings();

const BASE = "/api/v1/auth";
const ts = Date.now();

async function cleanupUser(username: string) {
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.username, username));
  } catch {
    // ignore
  }
}

async function listAuditActions(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs);
  return rows.map((r) => r.action);
}

Deno.test({
  name: "dead-switch: allow_register=false 时 /register 返 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    // 关闭注册
    await updateSetting("allow_register", false, "0");
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: {
        username: `reg_off_${ts}`,
        email: `reg_off_${ts}@example.com`,
        password: "TestPwd-2024-Xy9",
      },
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "REGISTER_DISABLED");

    // 恢复
    await updateSetting("allow_register", true, "0");
  },
});

Deno.test({
  name: "dead-switch: allow_register=true 时 /register 正常",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const res = await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: {
        username: `reg_on_${ts}`,
        email: `reg_on_${ts}@example.com`,
        password: "TestPwd-2024-Xy9",
      },
    });
    assertEquals(res.status, 201);
    await cleanupUser(`reg_on_${ts}`);
  },
});

Deno.test({
  name: "maintenance: maintenance_mode=true 时 POST 返 503 + MAINTENANCE code",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    // PR-2 评审修订：用 try/finally 包住设置与断言，**任何 assert 失败也会恢复 maintenance_mode**
    // 避免 DB 残留 true 导致后续 30+ 测试命中 maintenanceMode 中间件返 503
    await updateSetting("maintenance_mode", true, "0");
    try {
      const app = createApp();
      const res = await jsonRequest(app, `${BASE}/login`, {
        method: "POST",
        body: { login: "anyone", password: "anything" },
      });
      assertEquals(res.status, 503);
      const body = await res.json();
      assertEquals(body.code, "MAINTENANCE");

      // GET 仍可用（健康检查、查状态）
      const healthRes = await jsonRequest(app, "/health");
      assertEquals(healthRes.status, 200);
    } finally {
      // 任何 assert 失败 / 异常都执行：恢复 maintenance_mode=false
      await updateSetting("maintenance_mode", false, "0");
    }
  },
});

Deno.test({
  name: "audit: /register 写入 auth.register",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_reg_${ts}`;
    await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: {
        username,
        email: `${username}@example.com`,
        password: "TestPwd-2024-Xy9",
      },
    });

    const actions = await listAuditActions();
    assertEquals(actions.includes("auth.register"), true);

    await cleanupUser(username);
  },
});

Deno.test({
  name: "audit: /login 成功写入 auth.login_success",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_logins_${ts}`;
    const password = "TestPwd-2024-Xy9";

    await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: { username, email: `${username}@example.com`, password },
    });
    await jsonRequest(app, `${BASE}/login`, {
      method: "POST",
      body: { login: username, password },
    });

    const actions = await listAuditActions();
    assertEquals(actions.includes("auth.login_success"), true);

    await cleanupUser(username);
  },
});

Deno.test({
  name: "audit: /login 失败写入 auth.login_failure（reason=user_not_found）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    await jsonRequest(app, `${BASE}/login`, {
      method: "POST",
      body: { login: "nobody-here-12345", password: "wrong" },
    });

    const actions = await listAuditActions();
    assertEquals(actions.includes("auth.login_failure"), true);

    // 验证 detail 中 reason=user_not_found
    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "auth.login_failure"),
    );
    assertEquals(rows.length >= 1, true);
    const detail = rows[0].detail as { reason?: string };
    assertEquals(detail.reason, "user_not_found");
  },
});

Deno.test({
  name: "audit: /login 失败写入 auth.login_failure（reason=wrong_password）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_loginfail_${ts}`;
    const password = "CorrectPwd-Ab1";

    await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: { username, email: `${username}@example.com`, password },
    });
    await jsonRequest(app, `${BASE}/login`, {
      method: "POST",
      body: { login: username, password: "WrongPwd-Cd2" },
    });

    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "auth.login_failure"),
    );
    const row = rows.find((r) =>
      (r.detail as { reason?: string }).reason === "wrong_password"
    );
    assertEquals(!!row, true);

    await cleanupUser(username);
  },
});

Deno.test({
  name: "audit: /change-password 写入 auth.change_password",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_chpw_${ts}`;
    const oldPassword = "OldPwd-2024-Ab1";
    const newPassword = "NewPwd-2024-Cd2";

    const regRes = await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: {
        username,
        email: `${username}@example.com`,
        password: oldPassword,
      },
    });
    const regBody = (await regRes.json()) as { data: { id: string } };
    const token = await signToken({ sub: regBody.data.id, role: "user" });

    await jsonRequest(app, `${BASE}/change-password`, {
      method: "POST",
      token,
      body: { old_password: oldPassword, new_password: newPassword },
    });

    const actions = await listAuditActions();
    assertEquals(actions.includes("auth.change_password"), true);

    await cleanupUser(username);
  },
});

Deno.test({
  name: "audit: /forgot-password 未注册邮箱仍写审计（email_exists=false）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    await jsonRequest(app, `${BASE}/forgot-password`, {
      method: "POST",
      body: { email: `nobody-${ts}@example.com` },
    });

    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "auth.forgot_password_request"),
    );
    assertEquals(rows.length >= 1, true);
    const row = rows[rows.length - 1];
    const detail = row.detail as { email_exists?: boolean };
    assertEquals(detail.email_exists, false);
    // actor 缺失：admin_id 应为 null
    assertEquals(row.admin_id, null);
  },
});

Deno.test({
  name: "audit: /forgot-password 已注册邮箱写 email_exists=true",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_fpw_${ts}`;
    const email = `${username}@example.com`;

    await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: { username, email, password: "TestPwd-2024-Xy9" },
    });
    await jsonRequest(app, `${BASE}/forgot-password`, {
      method: "POST",
      body: { email },
    });

    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "auth.forgot_password_request"),
    );
    // 找到 email_exists=true 的那条
    const target = rows.find((r) =>
      (r.detail as { email_exists?: boolean }).email_exists === true
    );
    assertEquals(!!target, true);
    assertEquals(!!target?.admin_id, true); // 已注册用户 → actor 存在

    await cleanupUser(username);
  },
});

Deno.test({
  name: "audit: /reset-password 成功写入 auth.password_reset",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const app = createApp();
    const username = `audit_resetpw_${ts}`;
    const email = `${username}@example.com`;
    const oldPassword = "OrigPwd-2024-Ab1";
    const newPassword = "NewPwd-2024-Cd2";

    await jsonRequest(app, `${BASE}/register`, {
      method: "POST",
      body: { username, email, password: oldPassword },
    });
    await jsonRequest(app, `${BASE}/forgot-password`, {
      method: "POST",
      body: { email },
    });

    // 从 DB 拿 userId，签发有效 reset token
    const db = getDb();
    const userRows = await db.select({ id: users.id }).from(users).where(
      eq(users.username, username),
    ).limit(1);
    if (!userRows[0]) throw new Error("user not created");

    // 直接走 service 层（模拟邮件链接）—— 路由层仅做调用
    const { generateResetToken, hashResetToken } = await import(
      "../../src/lib/resetToken.ts"
    );
    const { passwordResetTokens } = await import(
      "../../src/db/schema.ts"
    );
    const plainToken = generateResetToken();
    const tokenHash = await hashResetToken(plainToken);
    await db.insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      user_id: userRows[0].id,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });

    await jsonRequest(app, `${BASE}/reset-password`, {
      method: "POST",
      body: { token: plainToken, new_password: newPassword },
    });

    const actions = await listAuditActions();
    assertEquals(actions.includes("auth.password_reset"), true);

    await cleanupUser(username);
  },
});

// 清理：重置系统设置快照
Deno.test({
  name: "dead-switch: 清理 system_settings 快照",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetSystemSettingsForTest();
    _resetEnvSnapshotForTest();
  },
});
