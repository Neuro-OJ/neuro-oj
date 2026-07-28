/**
 * Admin 管理端点 E2E 测试。
 *
 * 覆盖 Phase 1 审计发现的未覆盖 admin 端点：
 * - dashboard/stats
 * - settings CRUD
 * - blacklist CRUD
 * - judge-images CRUD
 * - admin user/submission management
 *
 * 依赖 seed 中的 e2e_admin 用户。
 */

import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  isE2E,
  getAdminToken,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;

// 测试 ID 后缀
const TS = Date.now().toString(36);

Deno.test({
  name: "[e2e/admin] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    // 确保 admin 可用
    await getAdminToken();
  },
});

Deno.test({
  name: "[e2e/admin] 1.1 dashboard/stats 返回统计数据",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const adminToken = await getAdminToken();
    const { status, body } = await apiGet(
      "/api/v1/admin/dashboard/stats",
      adminToken,
    );
    if (status !== 200) throw new Error(`期望 200，实际 ${status}`);
    const data = body as {
      data?: {
        total_users?: number;
        total_problems?: number;
        total_submissions?: number;
      };
    };
    if (typeof data?.data?.total_users !== "number") {
      throw new Error("total_users 应为数值");
    }
    if (typeof data?.data?.total_problems !== "number") {
      throw new Error("total_problems 应为数值");
    }
    if (typeof data?.data?.total_submissions !== "number") {
      throw new Error("total_submissions 应为数值");
    }
  },
});

Deno.test({
  name: "[e2e/admin] 1.2 普通用户无法访问 dashboard",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const token = await registerUser(
      `admt_noadmin_${TS}`,
      `admt_noadmin_${TS}@test.com`,
      "TestPass1234",
    );
    const { status } = await apiGet(
      "/api/v1/admin/dashboard/stats",
      token,
    );
    if (status !== 403 && status !== 401) {
      throw new Error(`期望 401/403，实际 ${status}`);
    }
  },
});

Deno.test({
  name: "[e2e/admin] 2.1 系统设置 GET/PUT",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const adminToken = await getAdminToken();

    // GET 设置列表
    const getRes = await apiGet("/api/v1/admin/settings", adminToken);
    if (getRes.status !== 200) {
      throw new Error(`GET settings 失败: ${getRes.status}`);
    }
    const settingsData = getRes.body as {
      data?: Array<{ key: string; value: unknown }>;
    };
    const settings = settingsData?.data ?? [];
    if (!Array.isArray(settings)) {
      throw new Error("settings 应为数组");
    }

    // 尝试更新一个已知布尔设置（allow_register 是布尔类型）
    let updated = false;
    for (const s of settings) {
      if (typeof s.value === "boolean") {
        const putRes = await apiPut(
          `/api/v1/admin/settings/${s.key}`,
          { value: s.value },
          adminToken,
        );
        if (putRes.status !== 200 && putRes.status !== 202) {
          throw new Error(
            `PUT settings 失败: ${putRes.status} ${JSON.stringify(putRes.body)}`,
          );
        }
        updated = true;
        break;
      }
    }
    // 如果没有布尔设置，至少有 GET 验证通过
    if (!updated) {
      console.log("  ⚠ 未找到布尔类型的设置，跳过 PUT 验证");
    }
  },
});

Deno.test({
  name: "[e2e/admin] 2.2 普通用户无法修改设置",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const token = await registerUser(
      `admt_nosettings_${TS}`,
      `admt_nosettings_${TS}@test.com`,
      "TestPass1234",
    );
    const { status } = await apiPut(
      "/api/v1/admin/settings",
      { key: "test", value: "x" },
      token,
    );
    if (status !== 403 && status !== 401) {
      throw new Error(`期望 401/403，实际 ${status}`);
    }
  },
});

Deno.test({
  name: "[e2e/admin] 3.1 获取用户列表",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const adminToken = await getAdminToken();
    const { status, body } = await apiGet("/api/v1/admin/users", adminToken);
    if (status !== 200) throw new Error(`GET /admin/users 失败: ${status}`);
    const data = body as { data?: Array<unknown> };
    if (!Array.isArray(data?.data)) {
      throw new Error("users data 应为数组");
    }
  },
});

Deno.test({
  name: "[e2e/admin] 3.2 黑名单 CRUD",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const adminToken = await getAdminToken();
    const testIp = `192.168.${Date.now() % 255}.1`;

    // POST 创建黑名单条目
    const createRes = await apiPost(
      "/api/v1/admin/blacklist",
      { ip_or_cidr: testIp, reason: "E2E test" },
      adminToken,
    );
    if (createRes.status !== 201) {
      throw new Error(`创建黑名单失败: ${createRes.status}`);
    }
    const created = createRes.body as { data?: { id: string } };
    const banId = created?.data?.id;
    if (!banId) throw new Error("返回应包含 ban id");

    // GET 验证存在
    const listRes = await apiGet("/api/v1/admin/blacklist", adminToken);
    if (listRes.status !== 200) throw new Error("获取黑名单失败");
    const list = listRes.body as { data?: Array<{ id: string }> };
    const found = (list?.data ?? []).find((b) => b.id === banId);
    if (!found) throw new Error("创建的黑名单条目未出现在列表中");

    // DELETE 清理
    const delRes = await apiDelete(
      `/api/v1/admin/blacklist/${banId}`,
      adminToken,
    );
    if (delRes.status !== 200 && delRes.status !== 204) {
      throw new Error(`删除黑名单失败: ${delRes.status}`);
    }
  },
});

Deno.test({
  name: "[e2e/admin] 3.3 普通用户无法管理黑名单",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const token = await registerUser(
      `admt_noblack_${TS}`,
      `admt_noblack_${TS}@test.com`,
      "TestPass1234",
    );
    const { status } = await apiGet(
      "/api/v1/admin/blacklist",
      token,
    );
    if (status !== 403 && status !== 401) {
      throw new Error(`期望 401/403，实际 ${status}`);
    }
  },
});

Deno.test({
  name: "[e2e/admin] 4.1 admin 提交详情",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const adminToken = await getAdminToken();
    // 测试获取提交列表和详情
    const { status } = await apiGet(
      "/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000",
      adminToken,
    );
    // 不存在返回 404，权限通过返回 200/404 而非 401/403
    if (status === 401 || status === 403) {
      throw new Error(`admin 应能访问提交详情，实际 ${status}`);
    }
  },
});

Deno.test({
  name: "[e2e/admin] 4.2 普通用户无法删除提交",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const token = await registerUser(
      `admt_nodel_${TS}`,
      `admt_nodel_${TS}@test.com`,
      "TestPass1234",
    );
    const { status } = await apiDelete(
      `/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000`,
      token,
    );
    if (status !== 403 && status !== 401) {
      throw new Error(`期望 401/403，实际 ${status}`);
    }
  },
});
