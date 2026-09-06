/**
 * 管理端邮件就绪状态与测试发送路由层测试（issue #426）。
 *
 * 覆盖场景：
 * - GET /settings/email/status：mock 开发环境返回 configured=true
 * - POST /settings/email/test-send：mock Provider 真实投递到 mock 邮箱
 * - POST /settings/email/test-send：收件邮箱非法返回 400
 * - EMAIL_PROVIDER=disabled 时：status configured=false，test-send 返回 400
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
} from "../../index.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../services/env-snapshot.ts";
import { takeMockEmailsForTest } from "../../services/email-providers/mock.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";

await initRedisForTest();

// 测试需要 JWT_SECRET 签发 token（与 admin-settings.test.ts 一致）
if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set(
    "JWT_SECRET",
    "test-secret-must-be-at-least-32-characters-long-xxx",
  );
}

async function setupWithProvider(provider: "mock" | "disabled") {
  Deno.env.set("EMAIL_PROVIDER", provider);
  _resetEnvSnapshotForTest();
  snapshotEnv();
  _resetSystemSettingsForTest();
  await initSystemSettings();
}

async function adminApp() {
  const token = await createUserToken("admin");
  return { app: createApp(), token };
}

Deno.test({
  name: "admin email status: mock 开发环境 configured=true 且测试邮件可投递",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await setupWithProvider("mock");
    const { app, token } = await adminApp();

    const statusRes = await jsonRequest(
      app,
      "/api/v1/admin/settings/email/status",
      { token },
    );
    assertEquals(statusRes.status, 200);
    assertEquals(await statusRes.json(), {
      data: { provider: "mock", configured: true, missing: [] },
    });

    takeMockEmailsForTest();
    const sendRes = await jsonRequest(
      app,
      "/api/v1/admin/settings/email/test-send",
      { method: "POST", body: { to: "admin@example.com" }, token },
    );
    assertEquals(sendRes.status, 200);
    assertEquals((await sendRes.json()).data.sent, true);
    const mailbox = takeMockEmailsForTest();
    assertEquals(mailbox.length, 1);
    assertEquals(mailbox[0].to, "admin@example.com");
  },
});

Deno.test({
  name: "admin email status: 非法收件邮箱返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await setupWithProvider("mock");
    const { app, token } = await adminApp();

    const res = await jsonRequest(
      app,
      "/api/v1/admin/settings/email/test-send",
      { method: "POST", body: { to: "not-an-email" }, token },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name:
    "admin email status: EMAIL_PROVIDER=disabled 时未就绪且 test-send 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await setupWithProvider("disabled");
    const { app, token } = await adminApp();

    const statusRes = await jsonRequest(
      app,
      "/api/v1/admin/settings/email/status",
      { token },
    );
    assertEquals(statusRes.status, 200);
    const status = await statusRes.json();
    assertEquals(status.data.provider, "disabled");
    assertEquals(status.data.configured, false);

    const sendRes = await jsonRequest(
      app,
      "/api/v1/admin/settings/email/test-send",
      { method: "POST", body: { to: "admin@example.com" }, token },
    );
    assertEquals(sendRes.status, 400);
    assertEquals((await sendRes.json()).code, "EMAIL_NOT_CONFIGURED");
  },
});
