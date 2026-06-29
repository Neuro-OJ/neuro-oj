/**
 * 管理员鉴权 E2E 测试。
 */

import {
  apiGet,
  apiPatch,
  isE2E,
  loginAndChangePassword,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";
const ADMIN_NEW_PASS = "E2eAdminChangedPass1";
let adminToken = "";
let regularToken = "";
let regularUserId = "";

Deno.test({
  name: "[e2e/auth] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await loginAndChangePassword(
      ADMIN_EMAIL,
      ADMIN_PASS,
      ADMIN_NEW_PASS,
    );
    const userTs = (Date.now() + 1).toString(36);
    regularToken = await registerUser(
      "auth_user_" + userTs,
      "auth_user_" + userTs + "@test.com",
      "Pass1234Test",
    );
    const res = await apiGet("/api/v1/auth/me", regularToken);
    regularUserId = (res.body as { data: { id: string } }).data.id;
  },
});

Deno.test({
  name: "[e2e/auth] 3.1 非管理员 promote 被拒",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPatch("/api/v1/admin/users/some-id/role", {
      role: "admin",
    }, regularToken);
    if (status !== 403) throw new Error("期望 403, 实际 " + status);
    console.log("  ✓ 非管理员 promote 被拒");
  },
});

Deno.test({
  name: "[e2e/auth] 3.2 缺少 role 字段",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPatch(
      "/api/v1/admin/users/some-id/role",
      {},
      adminToken,
    );
    if (status !== 400) throw new Error("期望 400, 实际 " + status);
    console.log("  ✓ 缺 role 400");
  },
});

Deno.test({
  name: "[e2e/auth] 3.3 非法角色值",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPatch("/api/v1/admin/users/some-id/role", {
      role: "superuser",
    }, adminToken);
    if (status !== 400) throw new Error("期望 400, 实际 " + status);
    console.log("  ✓ 非法角色 400");
  },
});

Deno.test({
  name: "[e2e/auth] 3.4 提升不存在的用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPatch(
      "/api/v1/admin/users/nonexistent-id/role",
      { role: "admin" },
      adminToken,
    );
    if (status !== 404) throw new Error("期望 404, 实际 " + status);
    console.log("  ✓ 不存在用户 404");
  },
});

Deno.test({
  name: "[e2e/auth] 3.5 管理员提升用户成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPatch(
      "/api/v1/admin/users/" + regularUserId + "/role",
      { role: "admin" },
      adminToken,
    );
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    const role = (body as { data: { role: string } }).data.role;
    if (role !== "admin") throw new Error("角色未更新");
    console.log("  ✓ 提升用户成功");
  },
});
