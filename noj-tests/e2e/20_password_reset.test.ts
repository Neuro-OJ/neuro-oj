/**
 * 密码重置流程 E2E 测试。
 *
 * 覆盖安全关键路径：
 * - forgot-password（防枚举）
 * - reset-password（令牌验证）
 *
 * 依赖 seed 中的 e2e_admin 用户。
 */

import {
  apiPost,
  isE2E,
  registerUser,
  waitForServer,
  e2eTest,

} from "./helper.ts";


let testEmail = "";

e2eTest("[e2e/pwd-reset] Setup", async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    testEmail = `pwdreset_${ts}@test.com`;
    await registerUser(
      `pwdreset_${ts}`,
      testEmail,
      "ResetPass1234",
    );
  });

e2eTest("[e2e/pwd-reset] 1.1 forgot-password 已存在邮箱返回 200", async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/auth/forgot-password", {
      email: testEmail,
    });
    // 防枚举：存在也返回 200
    if (status !== 200) {
      throw new Error(`期望 200，实际 ${status}`);
    }
  });

e2eTest("[e2e/pwd-reset] 1.2 forgot-password 不存在邮箱也返回 200", async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/auth/forgot-password", {
      email: "nonexistent_" + Date.now() + "@test.com",
    });
    // 防枚举：不存在也返回 200
    if (status !== 200) {
      throw new Error(`期望 200（防枚举），实际 ${status}`);
    }
  });

e2eTest("[e2e/pwd-reset] 1.3 forgot-password 空邮箱 400", async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/auth/forgot-password", {
      email: "",
    });
    if (status !== 400) {
      throw new Error(
        `空邮箱期望 400，实际 ${status}: ${JSON.stringify(body)}`,
      );
    }
  });

e2eTest("[e2e/pwd-reset] 1.4 reset-password 非法令牌 400", async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/auth/reset-password", {
      token: "invalid-token-12345",
      password: "NewPass1234!",
    });
    if (status !== 400 && status !== 401) {
      throw new Error(`非法令牌期望 400/401，实际 ${status}`);
    }
  });

e2eTest("[e2e/pwd-reset] 1.5 reset-password 弱密码 400", async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/auth/reset-password", {
      token: "some-valid-looking-uuid",
      password: "123",
    });
    if (status !== 400) {
      throw new Error(`弱密码期望 400，实际 ${status}`);
    }
  });
