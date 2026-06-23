/**
 * 提交列表 E2E 测试。
 */

import {
  apiGet,
  isE2E,
  loginUser,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";
let token = "";

Deno.test({
  name: "[e2e/submissions] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    token = await registerUser(
      "sub_user_" + ts,
      "sub_user_" + ts + "@test.com",
      "pass1234",
    );
  },
});

Deno.test({
  name: "[e2e/submissions] 4.1 无 token 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/submissions");
    if (status !== 401) throw new Error("期望 401");
    console.log("  ✓ 无 token 401");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.2 空列表+分页",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/submissions", token);
    if (status !== 200) throw new Error("期望 200");
    const d = body as {
      data: unknown[];
      pagination: { page: number; per_page: number; total: number };
    };
    if (!Array.isArray(d.data)) throw new Error("data 应数组");
    if (d.pagination.page !== 1) throw new Error("page 应 1");
    console.log("  ✓ 空列表 OK");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.3 非法 status 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet(
      "/api/v1/submissions?status=invalid",
      token,
    );
    if (status !== 400) throw new Error("期望 400");
    console.log("  ✓ 非法 status 400");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.4 admin 列表无 token 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/admin/submissions");
    if (status !== 401) throw new Error("期望 401");
    console.log("  ✓ admin 列表无 token 401");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.5 普通用户 admin 列表 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/admin/submissions", token);
    if (status !== 403) throw new Error("期望 403");
    const d = body as { error: string };
    if (d.error !== "需要管理员权限") throw new Error("错误信息不匹配");
    console.log("  ✓ 普通用户 admin 列表 403");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.6 admin 空列表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const adminT = await loginUser(ADMIN_EMAIL, ADMIN_PASS);
    const { status, body } = await apiGet("/api/v1/admin/submissions", adminT);
    if (status !== 200) throw new Error("期望 200");
    const d = body as { data: unknown[]; pagination: { total: number } };
    if (!Array.isArray(d.data)) throw new Error("data 应数组");
    console.log("  ✓ admin 列表 OK");
  },
});
