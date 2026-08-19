/**
 * TFA TOTP E2E 测试（issue #228）。
 *
 * 覆盖：
 * - 启用 TFA：setup + confirm 返回恢复码
 * - 登录：缺 code → TFA_REQUIRED；错误 code → 401；正确 TOTP → 成功
 * - 恢复码：登录成功且一次性消费
 * - 禁用 TFA：需验证码/恢复码确认
 * - 重新生成恢复码：旧码作废、新码可用
 */

import { TOTP } from "npm:otpauth@^9";
import {
  apiGet,
  apiPost,
  e2eTest,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

const ts = Date.now().toString(36);
let userLogin = `tfa_e2e_${ts}`;
let userEmail = `tfa_e2e_${ts}@test.com`;
let token = "";
let tfaSecret = "";
let recoveryCodes: string[] = [];

function currentCode(secret: string): string {
  return new TOTP({ secret, issuer: "NeuroOJ" }).generate();
}

e2eTest("[e2e/tfa] Setup: 注册并启用 TFA", async () => {
  if (!isE2E) return;
  await waitForServer();
  token = await registerUser(userLogin, userEmail, TEST_PASSWORD);

  const setupRes = await apiPost("/api/v1/auth/tfa/setup", {}, token);
  if (setupRes.status !== 200) {
    throw new Error(
      `setup 失败: ${setupRes.status} ${JSON.stringify(setupRes.body)}`,
    );
  }
  const setupData =
    (setupRes.body as { data: { secret: string; otpauth_url: string } }).data;
  tfaSecret = setupData.secret;

  const confirmRes = await apiPost(
    "/api/v1/auth/tfa/confirm",
    { code: currentCode(tfaSecret) },
    token,
  );
  if (confirmRes.status !== 200) {
    throw new Error(
      `confirm 失败: ${confirmRes.status} ${JSON.stringify(confirmRes.body)}`,
    );
  }
  recoveryCodes =
    (confirmRes.body as { data: { recovery_codes: string[] } }).data
      .recovery_codes;
  if (recoveryCodes.length !== 10) {
    throw new Error(`恢复码数量不是 10: ${recoveryCodes.length}`);
  }
});

e2eTest("[e2e/tfa] 登录缺少 code 返回 TFA_REQUIRED", async () => {
  if (!isE2E) return;
  const res = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
  });
  if (res.status !== 400) {
    throw new Error(`期望 400, 实际 ${res.status} ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { code?: string };
  if (body.code !== "TFA_REQUIRED") {
    throw new Error(`期望 TFA_REQUIRED, 实际 ${JSON.stringify(res.body)}`);
  }
});

e2eTest("[e2e/tfa] 登录错误 TOTP 被拒绝", async () => {
  if (!isE2E) return;
  const res = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code: "000000",
  });
  if (res.status !== 401) {
    throw new Error(`期望 401, 实际 ${res.status} ${JSON.stringify(res.body)}`);
  }
});

e2eTest("[e2e/tfa] 登录正确 TOTP 成功", async () => {
  if (!isE2E) return;
  const res = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code: currentCode(tfaSecret),
  });
  if (res.status !== 200) {
    throw new Error(`期望 200, 实际 ${res.status} ${JSON.stringify(res.body)}`);
  }
  const body = res.body as {
    data: { token: string; user: { tfa_enabled: boolean } };
  };
  if (body.data.user.tfa_enabled !== true) {
    throw new Error(`tfa_enabled 应为 true`);
  }
  if (typeof body.data.token !== "string") {
    throw new Error("缺少 token");
  }
});

e2eTest("[e2e/tfa] 恢复码登录成功且一次性消费", async () => {
  if (!isE2E) return;
  if (recoveryCodes.length === 0) throw new Error("缺少恢复码");
  const code = recoveryCodes.shift()!;
  const res = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code,
  });
  if (res.status !== 200) {
    throw new Error(
      `恢复码登录失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  // 同一恢复码第二次使用应失败
  const again = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code,
  });
  if (again.status !== 401) {
    throw new Error(`已使用恢复码应 401, 实际 ${again.status}`);
  }
});

e2eTest("[e2e/tfa] 重新生成恢复码后旧码作废", async () => {
  if (!isE2E) return;
  if (recoveryCodes.length === 0) throw new Error("缺少恢复码");
  const oldCode = recoveryCodes[0];
  const regenRes = await apiPost(
    "/api/v1/auth/tfa/recovery-codes/regenerate",
    { code: currentCode(tfaSecret) },
    token,
  );
  if (regenRes.status !== 200) {
    throw new Error(
      `regenerate 失败: ${regenRes.status} ${JSON.stringify(regenRes.body)}`,
    );
  }
  recoveryCodes = (regenRes.body as { data: { recovery_codes: string[] } }).data
    .recovery_codes;
  // 旧码不再可用
  const oldLogin = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code: oldCode,
  });
  if (oldLogin.status !== 401) {
    throw new Error(`旧恢复码应 401, 实际 ${oldLogin.status}`);
  }
  // 新码可用
  const newLogin = await apiPost("/api/v1/auth/login", {
    login: userLogin,
    password: TEST_PASSWORD,
    code: recoveryCodes[0],
  });
  if (newLogin.status !== 200) {
    throw new Error(`新恢复码应可登录, 实际 ${newLogin.status}`);
  }
});

e2eTest("[e2e/tfa] 禁用 TFA 需验证码确认", async () => {
  if (!isE2E) return;
  // 错误验证码不能禁用
  const badDisable = await apiPost("/api/v1/auth/tfa/disable", {
    code: "000000",
  }, token);
  if (badDisable.status !== 401) {
    throw new Error(`错误验证码禁用应 401, 实际 ${badDisable.status}`);
  }
  // 正确 TOTP 禁用成功
  const disableRes = await apiPost(
    "/api/v1/auth/tfa/disable",
    { code: currentCode(tfaSecret) },
    token,
  );
  if (disableRes.status !== 200) {
    throw new Error(
      `禁用失败: ${disableRes.status} ${JSON.stringify(disableRes.body)}`,
    );
  }
  const meRes = await apiGet("/api/v1/auth/me", token);
  const meBody = meRes.body as { data: { tfa_enabled: boolean } };
  if (meBody.data.tfa_enabled !== false) {
    throw new Error("禁用后 tfa_enabled 应为 false");
  }
});
