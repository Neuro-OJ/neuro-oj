/**
 * 注册门槛与注册可用状态路由层测试（issue #426）。
 *
 * 覆盖场景（EMAIL_PROVIDER=disabled 时）：
 * - 引导阶段（无真实用户）仍允许注册首个用户（成为管理员）
 * - 首个用户注册后，register-status 返回 allowed=false / email_unconfigured
 * - 后续公开注册被 403 REGISTER_EMAIL_UNCONFIGURED 拦截
 * - 邮件就绪（mock 开发环境）时 register-status 返回 allowed=true
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import {
  disableTestTransactionForFile,
  resetDbForTest,
} from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import { ne } from "drizzle-orm";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  resetEmailProvider,
} from "../../../system/index.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../../system/services/env-snapshot.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";

// 并发请求必须使用独立事务，不能由 preload 包在同一外层事务中。
disableTestTransactionForFile();
await initRedisForTest();

const BASE = "/api/v1/auth";
const ts = Date.now();

/** 按 issue #426 场景重置设置缓存（provider 由 env 决定，bootstrap 作用域）。 */
async function setupWithProvider(provider: "disabled" | "mock") {
  Deno.env.set("EMAIL_PROVIDER", provider);
  _resetEnvSnapshotForTest();
  snapshotEnv();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  resetEmailProvider();
}

async function registerPayload(username: string) {
  const app = createApp();
  return await jsonRequest(app, `${BASE}/register`, {
    method: "POST",
    body: {
      username,
      email: `${username}@example.com`,
      password: "TestPwd-2024-Xy9",
    },
  });
}

async function getRegisterStatus() {
  const app = createApp();
  return await jsonRequest(app, `${BASE}/register-status`);
}

Deno.test({
  name: "register-status: 未配置邮件时引导阶段仍可注册，之后公开注册被拦截",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await setupWithProvider("disabled");

    // 引导阶段：无真实用户，注册可用
    const before = await getRegisterStatus();
    assertEquals(before.status, 200);
    assertEquals(await before.json(), {
      data: { allowed: true, reason: null },
    });

    // 首个用户注册成功（成为管理员）
    const first = await registerPayload(`reg_gate_${ts}`);
    assertEquals(first.status, 201);

    // 首个用户之后：邮件未配置 → 公开注册不可用
    const after = await getRegisterStatus();
    assertEquals(after.status, 200);
    assertEquals(await after.json(), {
      data: { allowed: false, reason: "email_unconfigured" },
    });

    // 第二个注册请求被 403 拦截
    const second = await registerPayload(`reg_gate2_${ts}`);
    assertEquals(second.status, 403);
    assertEquals((await second.json()).code, "REGISTER_EMAIL_UNCONFIGURED");

    // 清理（与其他文件测试模式一致：FK 可能导致删除失败，静默忽略）
    try {
      const db = getDb();
      await db.delete(users).where(ne(users.username, ""));
    } catch {
      // ignore
    }
  },
});

Deno.test({
  name: "register-status: 邮件就绪（mock 开发环境）时始终可注册",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await setupWithProvider("mock");

    const first = await registerPayload(`reg_ok_${ts}`);
    assertEquals(first.status, 201);

    const status = await getRegisterStatus();
    assertEquals(status.status, 200);
    assertEquals(await status.json(), {
      data: { allowed: true, reason: null },
    });
  },
});

for (const provider of ["disabled", "mock"] as const) {
  Deno.test({
    name: `register-status: ${provider} 并发首次注册遵守邮件门槛`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      await resetDbForTest();
      await setupWithProvider(provider);
      const responses = await Promise.all([
        registerPayload(`race_a_${Date.now()}`),
        registerPayload(`race_b_${Date.now()}`),
      ]);
      assertEquals(
        responses.map((response) => response.status).sort(),
        provider === "disabled" ? [201, 403] : [201, 201],
      );
      const bodies = await Promise.all(
        responses.map((response) => response.json()),
      );
      const registered = bodies.filter((body) => body.data);
      assertEquals(registered.filter((body) => body.data.is_admin).length, 1);
      if (provider === "disabled") {
        assertEquals(
          bodies.find((body) => body.code)?.code,
          "REGISTER_EMAIL_UNCONFIGURED",
        );
      }
      const realUsers = await getDb().select({ id: users.id }).from(users)
        .where(ne(users.id, ROOT_USER_ID));
      assertEquals(realUsers.length, provider === "disabled" ? 1 : 2);
    },
  });
}
