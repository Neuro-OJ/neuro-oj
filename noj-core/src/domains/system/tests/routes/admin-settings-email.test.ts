/**
 * 管理端邮件就绪状态与测试发送路由层测试（issue #426）。
 *
 * 覆盖场景：
 * - GET /settings/email/status：mock 开发环境返回 configured=true
 * - POST /settings/email/test-send：mock Provider 真实投递到 mock 邮箱
 * - POST /settings/email/test-send：收件邮箱非法返回 400
 * - EMAIL_PROVIDER=disabled 时：status configured=false，test-send 返回 400
 *
 * 测试隔离（缺陷修复）：本文件原本在测试函数内直接 `Deno.env.set("EMAIL_PROVIDER", ...)`
 * 且**从不还原**，而 Deno 的测试文件共享同一进程环境。泄漏后果实测：同一次
 * `deno task test` 中，后续文件 seeds/smoke 触发
 * 「ForbiddenError: 邮件服务未配置，暂不接受注册」——
 * `seed_bootstrap_admin_test` 2 例、`tests/smoke.test.ts` 3 例共 5 例失败，
 * 且失败原因指向产品（注册被拒）而非测试污染，具有强误导性。
 *
 * 修复方式：统一经 `withProvider()` 进入，`finally` 中把 EMAIL_PROVIDER 还原为
 * 本文件触碰它之前的值（原本未设置则删除），并重刷 env 快照与系统设置缓存，
 * 保证不把状态留给同进程内后续文件。
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

/** 本文件触碰 EMAIL_PROVIDER 之前的原始值（未设置时为 undefined）。 */
const originalEmailProvider = Deno.env.get("EMAIL_PROVIDER");

async function setupWithProvider(provider: "mock" | "disabled") {
  Deno.env.set("EMAIL_PROVIDER", provider);
  _resetEnvSnapshotForTest();
  snapshotEnv();
  _resetSystemSettingsForTest();
  await initSystemSettings();
}

/**
 * 以指定 EMAIL_PROVIDER 运行一段断言，结束后**必定**还原环境。
 *
 * 必须用 try/finally：断言失败时同样要还原，否则一个失败用例会连带污染
 * 同进程后续测试文件，把单点失败放大成跨文件连锁失败。
 */
async function withProvider(
  provider: "mock" | "disabled",
  fn: () => Promise<void>,
) {
  await setupWithProvider(provider);
  try {
    await fn();
  } finally {
    if (originalEmailProvider === undefined) {
      Deno.env.delete("EMAIL_PROVIDER");
    } else {
      Deno.env.set("EMAIL_PROVIDER", originalEmailProvider);
    }
    _resetEnvSnapshotForTest();
    snapshotEnv();
    _resetSystemSettingsForTest();
    await initSystemSettings();
  }
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
    await withProvider("mock", async () => {
      const { app, token } = await adminApp();

      const statusRes = await jsonRequest(
        app,
        "/api/v1/admin/system/settings/email/status",
        { token },
      );
      assertEquals(statusRes.status, 200);
      assertEquals(await statusRes.json(), {
        data: { provider: "mock", configured: true, missing: [] },
      });

      takeMockEmailsForTest();
      const sendRes = await jsonRequest(
        app,
        "/api/v1/admin/system/settings/email/test-send",
        { method: "POST", body: { to: "admin@example.com" }, token },
      );
      assertEquals(sendRes.status, 200);
      assertEquals((await sendRes.json()).data.sent, true);
      const mailbox = takeMockEmailsForTest();
      assertEquals(mailbox.length, 1);
      assertEquals(mailbox[0].to, "admin@example.com");
    });
  },
});

Deno.test({
  name: "admin email status: 非法收件邮箱返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await withProvider("mock", async () => {
      const { app, token } = await adminApp();

      const res = await jsonRequest(
        app,
        "/api/v1/admin/system/settings/email/test-send",
        { method: "POST", body: { to: "not-an-email" }, token },
      );
      assertEquals(res.status, 400);
    });
  },
});

Deno.test({
  name:
    "admin email status: EMAIL_PROVIDER=disabled 时未就绪且 test-send 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await withProvider("disabled", async () => {
      const { app, token } = await adminApp();

      const statusRes = await jsonRequest(
        app,
        "/api/v1/admin/system/settings/email/status",
        { token },
      );
      assertEquals(statusRes.status, 200);
      const status = await statusRes.json();
      assertEquals(status.data.provider, "disabled");
      assertEquals(status.data.configured, false);

      const sendRes = await jsonRequest(
        app,
        "/api/v1/admin/system/settings/email/test-send",
        { method: "POST", body: { to: "admin@example.com" }, token },
      );
      assertEquals(sendRes.status, 400);
      assertEquals((await sendRes.json()).code, "EMAIL_NOT_CONFIGURED");
    });
  },
});
