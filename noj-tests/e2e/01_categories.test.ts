/**
 * 分类管理 E2E 测试。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  isE2E,
  loginAndChangePassword,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";
// E2E admin 改密后的密码（评审修复 H2：E2E 必须走完整强制改密流程验证 403 守卫）
const ADMIN_NEW_PASS = "E2eAdminChangedPass1";
let adminToken = "";

Deno.test({
  name: "[e2e/categories] Setup",
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
    console.log("  ✓ 管理员已登录并完成强制改密");
  },
});

Deno.test({
  name: "[e2e/categories] 1.1 GET 分类树",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/categories");
    if (status !== 200) throw new Error("期望 200");
    const d = body as { data: unknown[] };
    if (!Array.isArray(d.data)) throw new Error("data 应为数组");
    console.log("  ✓ 分类树正常");
  },
});

Deno.test({
  name: "[e2e/categories] 1.2 管理员创建顶级分类",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const slug = "e2e-cat-" + Date.now().toString(36);
    const { status, body } = await apiPost(
      "/api/v1/categories",
      { name: "E2E 分类", slug, description: "E2E 测试" },
      adminToken,
    );
    if (status !== 201) throw new Error("创建分类失败: " + status);
    const level = (body as { data: { level: number } }).data.level;
    if (level !== 0) throw new Error("顶级分类 level 应 0");
    console.log("  ✓ 管理员创建顶级分类");
  },
});

Deno.test({
  name: "[e2e/categories] 1.3 创建子分类自动计算 level",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const parentSlug = "e2e-parent-" + Date.now().toString(36);
    const parentRes = await apiPost("/api/v1/categories", {
      name: "E2E 父",
      slug: parentSlug,
    }, adminToken);
    if (parentRes.status !== 201) {
      throw new Error("创建父分类失败: " + parentRes.status);
    }
    const parentId = (parentRes.body as { data: { id: string } }).data.id;
    const childSlug = "e2e-child-" + Date.now().toString(36);
    const { body } = await apiPost("/api/v1/categories", {
      name: "E2E 子",
      slug: childSlug,
      parent_id: parentId,
    }, adminToken);
    const d = body as { data: { level: number; parent_id: string } };
    if (d.data.level !== 1) throw new Error("子分类 level 应 1");
    if (d.data.parent_id !== parentId) throw new Error("parent_id 不匹配");
    console.log("  ✓ 管理员创建子分类");
  },
});

Deno.test({
  name: "[e2e/categories] 1.4 未认证创建分类被拒",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/categories", {
      name: "Hack",
      slug: "hack-" + Date.now().toString(36),
    });
    if (status !== 401) throw new Error("期望 401, 实际 " + status);
    console.log("  ✓ 未认证创建分类被拒");
  },
});

Deno.test({
  name: "[e2e/categories] 1.5 重复 slug 冲突",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const slug = "e2e-dup-" + Date.now().toString(36);
    await apiPost("/api/v1/categories", { name: "原始", slug }, adminToken);
    const { status } = await apiPost("/api/v1/categories", {
      name: "重复",
      slug,
    }, adminToken);
    if (status !== 409) throw new Error("期望 409, 实际 " + status);
    console.log("  ✓ 重复 slug 冲突检测正常");
  },
});

Deno.test({
  name: "[e2e/categories] 1.6 删除带子分类的分类被拒",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const slug = "e2e-del-parent-" + Date.now().toString(36);
    const parentRes = await apiPost("/api/v1/categories", {
      name: "要删的父",
      slug,
    }, adminToken);
    if (parentRes.status !== 201) throw new Error("创建父分类失败");
    const parentId = (parentRes.body as { data: { id: string } }).data.id;
    await apiPost("/api/v1/categories", {
      name: "子",
      slug: slug + "-child",
      parent_id: parentId,
    }, adminToken);
    const { status } = await apiDelete(
      "/api/v1/categories/" + parentId,
      adminToken,
    );
    if (status !== 400) throw new Error("期望 400, 实际 " + status);
    console.log("  ✓ 删除带子分类的分类被拒");
  },
});
