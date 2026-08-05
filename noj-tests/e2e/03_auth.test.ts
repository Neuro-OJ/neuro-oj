/**
 * 管理员鉴权 E2E 测试。
 */

import {
  apiGet,
  apiPatch,
  getAdminToken,
  isE2E,
  registerUser,
  waitForServer,
  e2eTest,
  TEST_PASSWORD,

} from "./helper.ts";

let adminToken = "";
let regularToken = "";
let regularUserId = "";
let adminRoleId = "";

/** 获取角色 ID（通过 /admin/roles API） */
async function ensureRoleIds(): Promise<void> {
  if (adminRoleId) return;
  const res = await apiGet("/api/v1/admin/roles", adminToken);
  const roles =
    (res.body as { data: Array<{ id: string; name: string }> }).data ?? [];
  const admin = roles.find((r) => r.name === "admin");
  const user = roles.find((r) => r.name === "user");
  if (admin) adminRoleId = admin.id;
}

e2eTest("[e2e/auth] Setup", async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
    await ensureRoleIds();
    const userTs = (Date.now() + 1).toString(36);
    regularToken = await registerUser(
      "auth_user_" + userTs,
      "auth_user_" + userTs + "@test.com",
      TEST_PASSWORD,
    );
    const res = await apiGet("/api/v1/auth/me", regularToken);
    regularUserId = (res.body as { data: { id: string } }).data.id;
  });

e2eTest("[e2e/auth] 3.1 非管理员 promote 被拒", async () => {
    if (!isE2E) return;
    const { status } = await apiPatch("/api/v1/admin/users/some-id/role", {
      role_ids: ["some-id"],
    }, regularToken);
    if (status !== 403) throw new Error("期望 403, 实际 " + status);
    console.log("  ✓ 非管理员 promote 被拒");
  });

e2eTest("[e2e/auth] 3.2 缺少 role_ids 字段", async () => {
    if (!isE2E) return;
    const { status } = await apiPatch(
      "/api/v1/admin/users/some-id/role",
      {},
      adminToken,
    );
    if (status !== 400) throw new Error("期望 400, 实际 " + status);
    console.log("  ✓ 缺 role_ids 400");
  });

e2eTest("[e2e/auth] 3.3 非法角色 ID", async () => {
    if (!isE2E) return;
    // 使用有效的用户查询来区分 404(用户不存在) vs 400(role_ids 无效)
    const { status } = await apiPatch(
      "/api/v1/admin/users/" + regularUserId + "/role",
      {
        role_ids: ["00000000-0000-0000-0000-000000000000"],
      },
      adminToken,
    );
    if (status !== 400) throw new Error("期望 400, 实际 " + status);
    console.log("  ✓ 非法角色 ID 400");
  });

e2eTest("[e2e/auth] 3.4 提升不存在的用户", async () => {
    if (!isE2E) return;
    const { status } = await apiPatch(
      "/api/v1/admin/users/nonexistent-id/role",
      { role_ids: [adminRoleId || "00000000-0000-0000-0000-000000000000"] },
      adminToken,
    );
    if (status !== 404) throw new Error("期望 404, 实际 " + status);
    console.log("  ✓ 不存在用户 404");
  });

e2eTest("[e2e/auth] 3.5 管理员提升用户成功", async () => {
    if (!isE2E) return;
    const { status } = await apiPatch(
      "/api/v1/admin/users/" + regularUserId + "/role",
      { role_ids: [adminRoleId] },
      adminToken,
    );
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    console.log("  ✓ 提升用户成功");
    console.log("  ✓ 提升用户成功");
  });
