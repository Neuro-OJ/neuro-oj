/**
 * 管理员鉴权 E2E 测试。
 */

import {
  apiGet,
  apiPatch,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

let adminToken = "";
let regularToken = "";
let regularUserId = "";

e2eTest("[e2e/auth] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
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
  const { status } = await apiPatch(
    "/api/v1/admin/identity/users/some-id/role",
    {
      role: "admin",
    },
    regularToken,
  );
  if (status !== 403) throw new Error("期望 403, 实际 " + status);
  console.log("  ✓ 非管理员 promote 被拒");
});

e2eTest("[e2e/auth] 3.2 缺少 role 字段", async () => {
  if (!isE2E) return;
  const { status } = await apiPatch(
    "/api/v1/admin/identity/users/some-id/role",
    {},
    adminToken,
  );
  if (status !== 400) throw new Error("期望 400, 实际 " + status);
  console.log("  ✓ 缺 role 400");
});

e2eTest("[e2e/auth] 3.3 非法角色 ID", async () => {
  if (!isE2E) return;
  // 数组角色与未知角色值都必须 400。
  const arrayStatus = (await apiPatch(
    "/api/v1/admin/identity/users/" + regularUserId + "/role",
    { role_ids: ["admin"] },
    adminToken,
  )).status;
  if (arrayStatus !== 400) {
    throw new Error("数组角色期望 400, 实际 " + arrayStatus);
  }
  const { status } = await apiPatch(
    "/api/v1/admin/identity/users/" + regularUserId + "/role",
    { role: "moderator" },
    adminToken,
  );
  if (status !== 400) throw new Error("期望 400, 实际 " + status);
  console.log("  ✓ 非法角色值 400");
});

e2eTest("[e2e/auth] 3.4 提升不存在的用户", async () => {
  if (!isE2E) return;
  const { status } = await apiPatch(
    "/api/v1/admin/identity/users/nonexistent-id/role",
    { role: "admin" },
    adminToken,
  );
  if (status !== 404) throw new Error("期望 404, 实际 " + status);
  console.log("  ✓ 不存在用户 404");
});

e2eTest("[e2e/auth] 3.5 管理员提升用户成功", async () => {
  if (!isE2E) return;
  const { status } = await apiPatch(
    "/api/v1/admin/identity/users/" + regularUserId + "/role",
    { role: "admin" },
    adminToken,
  );
  if (status !== 200) throw new Error("期望 200, 实际 " + status);
  console.log("  ✓ 提升用户成功");
  console.log("  ✓ 提升用户成功");
});
