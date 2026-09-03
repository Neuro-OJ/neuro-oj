/**
 * TFA 管理路由测试（issue #228）。
 *
 * 覆盖：
 * - POST /api/v1/auth/tfa/setup
 * - POST /api/v1/auth/tfa/confirm
 * - POST /api/v1/auth/tfa/disable
 * - POST /api/v1/auth/tfa/recovery-codes/regenerate
 * - 登录缺 code 返回 TFA_REQUIRED
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { TOTP } from "otpauth";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "./../../src/shared/db/connection.ts";
import { registerUser } from "../../src/domains/identity/index.ts";
import { signToken } from "./../../src/domains/identity/services/security/jwt.ts";
import { jsonRequest } from "../helper.ts";

Deno.env.set("TFA_ENCRYPTION_KEY", "test-tfa-encryption-key-with-32-chars-min");
Deno.env.set("JWT_SECRET", "test-jwt-secret-with-at-least-32-characters");
if (!Deno.env.get("REDIS_URL")) {
  Deno.env.set("RATE_LIMIT_ENABLED", "false");
}

await resetDbForTest();

const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !hasJwt;
const BASE = "/api/v1/auth";
const ts = Date.now();

function currentCode(secret: string): string {
  return new TOTP({ secret, issuer: "NeuroOJ" }).generate();
}

async function freshUserAndToken() {
  const user = await registerUser({
    username: `tfa-route-${ts}-${crypto.randomUUID().slice(0, 8)}`,
    email: `tfa-route-${ts}-${crypto.randomUUID().slice(0, 8)}@example.com`,
    password: "TestPwd-2024-Xy9",
  });
  const token = await signToken({ sub: user.id, role: "user" });
  return { user, token };
}

Deno.test({
  name: "route tfa: setup 返回 secret/otpauth_url，confirm 后 /me 显示已启用",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { token } = await freshUserAndToken();

    const setupRes = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    assertEquals(setupRes.status, 200);
    const setupBody = await setupRes.json();
    assertEquals(typeof setupBody.data.secret, "string");
    assertEquals(setupBody.data.otpauth_url.includes("otpauth://"), true);

    const confirmRes = await jsonRequest(app, `${BASE}/tfa/confirm`, {
      method: "POST",
      body: { code: currentCode(setupBody.data.secret) },
      token,
    });
    assertEquals(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assertEquals(confirmBody.data.recovery_codes.length, 10);

    const meRes = await jsonRequest(app, `${BASE}/me`, { token });
    const meBody = await meRes.json();
    assertEquals(meBody.data.tfa_enabled, true);
  },
});

Deno.test({
  name: "route tfa: 已启用后再次 setup 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { token } = await freshUserAndToken();
    const setupRes = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    const { secret } = (await setupRes.json()).data;
    await jsonRequest(app, `${BASE}/tfa/confirm`, {
      method: "POST",
      body: { code: currentCode(secret) },
      token,
    });
    const again = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    assertEquals(again.status, 400);
  },
});

Deno.test({
  name: "route tfa: disable 使用 TOTP 成功后 /me 显示未启用",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { token } = await freshUserAndToken();
    const setupRes = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    const { secret } = (await setupRes.json()).data;
    await jsonRequest(app, `${BASE}/tfa/confirm`, {
      method: "POST",
      body: { code: currentCode(secret) },
      token,
    });
    const disableRes = await jsonRequest(app, `${BASE}/tfa/disable`, {
      method: "POST",
      body: { code: currentCode(secret) },
      token,
    });
    assertEquals(disableRes.status, 200);
    const meRes = await jsonRequest(app, `${BASE}/me`, { token });
    const meBody = await meRes.json();
    assertEquals(meBody.data.tfa_enabled, false);
  },
});

Deno.test({
  name: "route tfa: regenerate 返回新恢复码",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { token } = await freshUserAndToken();
    const setupRes = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    const { secret } = (await setupRes.json()).data;
    await jsonRequest(app, `${BASE}/tfa/confirm`, {
      method: "POST",
      body: { code: currentCode(secret) },
      token,
    });
    const regenRes = await jsonRequest(
      app,
      `${BASE}/tfa/recovery-codes/regenerate`,
      {
        method: "POST",
        body: { code: currentCode(secret) },
        token,
      },
    );
    assertEquals(regenRes.status, 200);
    const regenBody = await regenRes.json();
    assertEquals(regenBody.data.recovery_codes.length, 10);
  },
});

Deno.test({
  name: "route login: 已启用 TFA 用户缺少 code 返回 TFA_REQUIRED",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { user, token } = await freshUserAndToken();
    const setupRes = await jsonRequest(app, `${BASE}/tfa/setup`, {
      method: "POST",
      token,
    });
    const { secret } = (await setupRes.json()).data;
    await jsonRequest(app, `${BASE}/tfa/confirm`, {
      method: "POST",
      body: { code: currentCode(secret) },
      token,
    });

    const loginRes = await jsonRequest(app, `${BASE}/login`, {
      method: "POST",
      body: { login: user.username, password: "TestPwd-2024-Xy9" },
      ip: "10.1.1.1",
    });
    assertEquals(loginRes.status, 400);
    const loginBody = await loginRes.json();
    assertEquals(loginBody.code, "TFA_REQUIRED");
  },
});
