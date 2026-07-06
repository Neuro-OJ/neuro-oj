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
 *
 * 幂等设计：如果数据库是复用的（前次运行已改密），则初始密码登录失败，
 * 此时用新密码登录并跳过守卫测试（因 must_change_password flag 已清除）。
 */

import { apiGet, apiPost, isE2E, loginUser, waitForServer } from "./helper.ts";

const skip = !isE2E;
const PWCHANGE_EMAIL = "e2e_pwchange@test.com";
const PWCHANGE_PASS = "e2e_pwchange_pass_8chars";
const PWCHANGE_NEW_PASS = "E2ePwchangeChanged1";
let flagToken = "";
let guardAvailable = false; // false 表示改密已被执行过，无法测试守卫

Deno.test({
  name: "[e2e/guard] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    // 先试初始密码（须有 must_change_password flag）
    try {
      flagToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_PASS);
      guardAvailable = true;
      console.log("  ✓ 守卫测试用户已登录（must_change_password=true）");
    } catch {
      // 初始密码失败 → 密码已被前次运行改过，用新密码登录
      flagToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_NEW_PASS);
      guardAvailable = false;
      console.log("  ⚠ 守卫测试用户已改密，跳过守卫拦截测试（仅测改密后路径）");
    }
  },
});

Deno.test({
  name: "[e2e/guard] 1.1 非白名单 API 返回 403 PASSWORD_CHANGE_REQUIRED",
  ignore: skip || !guardAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/admin/users", flagToken);
    if (status !== 403) throw new Error("期望 403, 实际 " + status);
    const b = body as { code?: string };
    if (b.code !== "PASSWORD_CHANGE_REQUIRED") {
      throw new Error("期望 code=PASSWORD_CHANGE_REQUIRED, 实际 " + b.code);
    }
    console.log("  ✓ 非白名单 API 403 + PASSWORD_CHANGE_REQUIRED");
  },
});

Deno.test({
  name: "[e2e/guard] 1.2 /api/v1/auth/me 白名单放行",
  ignore: skip || !guardAvailable,
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
  name: "[e2e/guard] 1.3 /api/v1/auth/logout 端点存在（no-op 不走中间件）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/auth/logout", {}, flagToken);
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    const b = body as { data?: { ok?: boolean } };
    if (b.data?.ok !== true) throw new Error("期望 data.ok=true, 实际 " + JSON.stringify(b));
    console.log("  ✓ /logout 端点存在且不受守卫拦截（no-op 设计）");
  },
});

Deno.test({
  name: "[e2e/guard] 1.4 /api/v1/auth/change-password 白名单放行",
  ignore: skip || !guardAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost(
      "/api/v1/auth/change-password",
      { old_password: PWCHANGE_PASS, new_password: PWCHANGE_NEW_PASS },
      flagToken,
    );
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    const b = body as { data: { must_change_password: boolean } };
    if (b.data.must_change_password !== false) {
      throw new Error("改密后 must_change_password 应为 false");
    }
    console.log("  ✓ 改密成功，flag 已清除");
  },
});

Deno.test({
  name: "[e2e/guard] 1.5 改密后非白名单 API 恢复正常",
  ignore: skip || !guardAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 用新密码登录拿到无 flag 的 token
    const cleanToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_NEW_PASS);
    const { status } = await apiGet("/api/v1/submissions", cleanToken);
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    console.log("  ✓ 改密后 token 通行");
  },
});

Deno.test({
  name: "[e2e/guard] 1.6 pwchange 限流桶独立（评审修复 M3）",
  ignore: skip || !guardAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const cleanToken = await loginUser(PWCHANGE_EMAIL, PWCHANGE_NEW_PASS);
    for (let i = 0; i < 6; i++) {
      await apiPost(
        "/api/v1/auth/change-password",
        { old_password: "wrong_password_x", new_password: "X".repeat(20) },
        cleanToken,
      );
    }
    const { status } = await apiGet("/api/v1/submissions", cleanToken);
    if (status !== 200) throw new Error("pwchange 限流污染了 token 路径: " + status);
    console.log("  ✓ pwchange 限流不污染 /login");
  },
});
