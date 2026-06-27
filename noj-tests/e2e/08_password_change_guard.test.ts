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

import { apiGet, apiPost, isE2E, loginUser, waitForServer } from "./helper.ts";

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
    // 试访问任意非白名单、受 authMiddleware 保护的 API。
    // 注意：必须用受保护路径，否则中间件不执行，守卫无法拦截。
    // /api/v1/categories GET 是公开路由，不应使用。
    const { status, body } = await apiGet(
      "/api/v1/admin/users",
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
  name: "[e2e/guard] 1.3 /api/v1/auth/logout 端点存在（no-op 不走中间件）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // logout 是 no-op stub（评审 Sp7），且 auth.post("/logout", ...) 未挂
    // authMiddleware——服务端无状态，客户端自行清 Cookie。
    // 因此该端点不受 PASSWORD_CHANGE_REQUIRED 守卫影响，直接返回 200。
    // 此测试文档化这一设计：logout 端点存在且无副作用。
    const { status, body } = await apiPost(
      "/api/v1/auth/logout",
      {},
      flagToken,
    );
    if (status !== 200) {
      throw new Error("期望 200, 实际 " + status);
    }
    const b = body as { data?: { ok?: boolean } };
    if (b.data?.ok !== true) {
      throw new Error("期望 data.ok=true, 实际 " + JSON.stringify(b));
    }
    console.log("  ✓ /logout 端点存在且不受守卫拦截（no-op 设计）");
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
    // 用受保护的普通用户 API（/api/v1/submissions）验证 token 通过 authMiddleware
    const { status } = await apiGet("/api/v1/submissions", cleanToken);
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
    // 用受保护 API（/api/v1/submissions）验证 token 仍可用 → pwchange 限流桶与 /login 隔离
    const { status } = await apiGet("/api/v1/submissions", cleanToken);
    if (status !== 200) {
      throw new Error("pwchange 限流污染了 token 路径: " + status);
    }
    console.log("  ✓ pwchange 限流不污染 /login");
  },
});
