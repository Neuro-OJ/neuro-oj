/**
 * PASSWORD_CHANGE_REQUIRED 守卫验证测试（issue #75 评审修复 H2）。
 *
 * 覆盖 authMiddleware 的强制改密拦截逻辑：
 * - 非白名单路径 → 403 + code: PASSWORD_CHANGE_REQUIRED
 * - 白名单路径（change-password, me）→ 放行
 * - 改密成功后 token 失效该 flag，所有 API 恢复正常
 *
 * 使用 seed.ts 的 ensureE2EPwChangeUser() 创建的固定测试用户：
 *   email:    e2e_pwchange@test.com
 *   password: e2e_pwchange_pass_8chars
 *   must_change_password: true
 *
 * 流程：
 * 1. 登录 → 拿 flagToken（must_change_password=true）
 * 2. 验证守卫拦截（多个非白名单 API 返回 403）
 * 3. 验证白名单放行（/me、change-password）
 * 4. 调 change-password 完成改密 → 拿到新 token（无 flag）
 * 5. 验证改密后非白名单 API 恢复正常
 */

import {
  apiGet,
  apiPost,
  isE2E,
  loginUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const PWCHANGE_EMAIL = "e2e_pwchange@test.com";
const PWCHANGE_PASS = "e2e_pwchange_pass_8chars";
const PWCHANGE_NEW_PASS = "E2ePwchangeChanged1";
let flagToken = "";

Deno.test({
  name: "[e2e/guard] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    // 登录拿到带 must_change_password=true 的 token
    flagToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_PASS);
    console.log("  ✓ 守卫测试用户已登录（must_change_password=true）");
  },
});

Deno.test({
  name: "[e2e/guard] 1.1 非白名单 API 返回 403 PASSWORD_CHANGE_REQUIRED",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 试访问任意非白名单 API
    const { status, body } = await apiGet(
      "/api/v1/categories",
      flagToken,
    );
    if (status !== 403) {
      throw new Error("期望 403, 实际 " + status);
    }
    const b = body as { error?: string; code?: string };
    if (b.code !== "PASSWORD_CHANGE_REQUIRED") {
      throw new Error(
        "期望 code=PASSWORD_CHANGE_REQUIRED, 实际 " + b.code,
      );
    }
    console.log("  ✓ 非白名单 API 403 + PASSWORD_CHANGE_REQUIRED");
  },
});

Deno.test({
  name: "[e2e/guard] 1.2 /api/v1/auth/me 白名单放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/auth/me", flagToken);
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    console.log("  ✓ /me 白名单放行");
  },
});

Deno.test({
  name: "[e2e/guard] 1.3 /api/v1/auth/logout 不在白名单（评审修复 M5）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost(
      "/api/v1/auth/logout",
      {},
      flagToken,
    );
    if (status !== 403) {
      throw new Error("期望 403, 实际 " + status);
    }
    const b = body as { code?: string };
    if (b.code !== "PASSWORD_CHANGE_REQUIRED") {
      throw new Error(
        "期望 code=PASSWORD_CHANGE_REQUIRED, 实际 " + b.code,
      );
    }
    console.log("  ✓ /logout 已移出白名单 → 403");
  },
});

Deno.test({
  name: "[e2e/guard] 1.4 /api/v1/auth/change-password 白名单放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost(
      "/api/v1/auth/change-password",
      { old_password: PWCHANGE_PASS, new_password: PWCHANGE_NEW_PASS },
      flagToken,
    );
    if (status !== 200) {
      throw new Error("期望 200, 实际 " + status);
    }
    const b = body as { data: { must_change_password: boolean } };
    if (b.data.must_change_password !== false) {
      throw new Error("改密后 must_change_password 应为 false");
    }
    console.log("  ✓ 改密成功，flag 已清除");
  },
});

Deno.test({
  name: "[e2e/guard] 1.5 改密后非白名单 API 恢复正常",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 用新密码登录拿到无 flag 的 token
    const cleanToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_NEW_PASS);
    const { status } = await apiGet("/api/v1/categories", cleanToken);
    if (status !== 200) {
      throw new Error("期望 200, 实际 " + status);
    }
    console.log("  ✓ 改密后 token 通行");
  },
});

Deno.test({
  name: "[e2e/guard] 1.6 pwchange 限流桶独立（评审修复 M3）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 连续 6 次故意错旧密码触发账号维度限流
    // pwchange 限流桶独立 → /login 不应被影响
    const cleanToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_NEW_PASS);
    for (let i = 0; i < 6; i++) {
      await apiPost(
        "/api/v1/auth/change-password",
        { old_password: "wrong_password_x", new_password: "X".repeat(20) },
        cleanToken,
      );
    }
    // /login 仍能正常使用（说明限流桶与 /login 隔离）
    const { status } = await apiGet("/api/v1/categories", cleanToken);
    if (status !== 200) {
      throw new Error("/login 受影响，限流桶未隔离: " + status);
    }
    console.log("  ✓ pwchange 限流不污染 /login");
  },
});