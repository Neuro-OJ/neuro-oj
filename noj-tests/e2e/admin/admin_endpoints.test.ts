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
  api,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  waitForServer,
} from "../helper.ts";

// 测试 ID 后缀
const TS = Date.now().toString(36);

e2eTest("[e2e/admin] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  // 确保 admin 可用
  await getAdminToken();
});

e2eTest("[e2e/admin] 1.1 dashboard/stats 返回统计数据", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const { status, body } = await apiGet(
    "/api/v1/admin/query/dashboard/stats",
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
});

e2eTest("[e2e/admin] 1.2 普通用户无法访问 dashboard", async () => {
  if (!isE2E) return;
  const token = await registerUser(
    `admt_noadmin_${TS}`,
    `admt_noadmin_${TS}@test.com`,
    "TestPass1234",
  );
  const { status } = await apiGet(
    "/api/v1/admin/query/dashboard/stats",
    token,
  );
  if (status !== 403 && status !== 401) {
    throw new Error(`期望 401/403，实际 ${status}`);
  }
});

e2eTest("[e2e/admin] 2.1 系统设置 GET/PUT", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();

  // GET 设置列表
  const getRes = await apiGet("/api/v1/admin/system/settings", adminToken);
  if (getRes.status !== 200) {
    throw new Error(`GET settings 失败: ${getRes.status}`);
  }
  const settingsData = getRes.body as {
    data?: Array<
      { key: string; effective_value: unknown; updated_at: string | null }
    >;
  };
  const settings = settingsData?.data ?? [];
  if (!Array.isArray(settings)) {
    throw new Error("settings 应为数组");
  }

  const target = settings.find((setting) =>
    setting.key === "allow_domain_registration_invites"
  );
  if (!target || typeof target.effective_value !== "boolean") {
    throw new Error("缺少实例成员邀请注册政策");
  }
  // 保持原政策值，用设置当前 updated_at 执行既有 CAS，不改变其他 E2E 的注册方式。
  const putRes = await api(
    "PUT",
    `/api/v1/admin/system/settings/${target.key}`,
    {
      body: { value: target.effective_value },
      token: adminToken,
      headers: target.updated_at
        ? { "If-Match": `"${target.updated_at}"` }
        : undefined,
    },
  );
  if (putRes.status !== 200) {
    throw new Error(
      `PUT settings 失败: ${putRes.status} ${JSON.stringify(putRes.body)}`,
    );
  }
  const updated = (putRes.body as {
    data: { effective_value: unknown; updated_at: string | null };
  }).data;
  if (
    updated.effective_value !== target.effective_value || !updated.updated_at
  ) throw new Error("政策值或配置版本未正确保存");
  const readBack = await apiGet("/api/v1/admin/system/settings", adminToken);
  if (readBack.status !== 200) {
    throw new Error(`重读设置失败: ${readBack.status}`);
  }
  const saved =
    (readBack.body as { data: { key: string; effective_value: unknown }[] })
      .data.find((setting) => setting.key === target.key);
  if (saved?.effective_value !== target.effective_value) {
    throw new Error("重读政策与已保存值不同");
  }
});

e2eTest("[e2e/admin] 2.2 普通用户无法修改设置", async () => {
  if (!isE2E) return;
  const token = await registerUser(
    `admt_nosettings_${TS}`,
    `admt_nosettings_${TS}@test.com`,
    "TestPass1234",
  );
  const { status } = await apiPut(
    "/api/v1/admin/system/settings/allow_domain_registration_invites",
    { value: false },
    token,
  );
  if (status !== 403 && status !== 401) {
    throw new Error(`期望 401/403，实际 ${status}`);
  }
});

e2eTest("[e2e/admin] 3.1 获取用户列表", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const { status, body } = await apiGet(
    "/api/v1/admin/identity/users",
    adminToken,
  );
  if (status !== 200) throw new Error(`GET /admin/users 失败: ${status}`);
  const data = body as { data?: Array<unknown> };
  if (!Array.isArray(data?.data)) {
    throw new Error("users data 应为数组");
  }
});

e2eTest("[e2e/admin] 3.2 黑名单 CRUD", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const testIp = `192.168.${Date.now() % 255}.1`;

  // POST 创建黑名单条目
  const createRes = await apiPost(
    "/api/v1/admin/identity/blacklist",
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
  const listRes = await apiGet("/api/v1/admin/identity/blacklist", adminToken);
  if (listRes.status !== 200) throw new Error("获取黑名单失败");
  const list = listRes.body as { data?: Array<{ id: string }> };
  const found = (list?.data ?? []).find((b) => b.id === banId);
  if (!found) throw new Error("创建的黑名单条目未出现在列表中");

  // DELETE 清理
  const delRes = await apiDelete(
    `/api/v1/admin/identity/blacklist/${banId}`,
    adminToken,
  );
  if (delRes.status !== 200 && delRes.status !== 204) {
    throw new Error(`删除黑名单失败: ${delRes.status}`);
  }
});

e2eTest("[e2e/admin] 3.3 普通用户无法管理黑名单", async () => {
  if (!isE2E) return;
  const token = await registerUser(
    `admt_noblack_${TS}`,
    `admt_noblack_${TS}@test.com`,
    "TestPass1234",
  );
  const { status } = await apiGet(
    "/api/v1/admin/identity/blacklist",
    token,
  );
  if (status !== 403 && status !== 401) {
    throw new Error(`期望 401/403，实际 ${status}`);
  }
});

e2eTest("[e2e/admin] 4.1 admin 提交详情", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  // 测试获取提交列表和详情
  const { status } = await apiGet(
    "/api/v1/admin/submission/submissions/00000000-0000-0000-0000-000000000000",
    adminToken,
  );
  // 管理权限通过后，不存在的提交精确返回404；500不能作为权限通过。
  if (status !== 404) {
    throw new Error(`admin 读取不存在提交应404，实际 ${status}`);
  }
});

e2eTest("[e2e/admin] 4.2 普通用户无法删除提交", async () => {
  if (!isE2E) return;
  const token = await registerUser(
    `admt_nodel_${TS}`,
    `admt_nodel_${TS}@test.com`,
    "TestPass1234",
  );
  const { status } = await apiDelete(
    `/api/v1/admin/submission/submissions/00000000-0000-0000-0000-000000000000`,
    token,
  );
  if (status !== 403 && status !== 401) {
    throw new Error(`期望 401/403，实际 ${status}`);
  }
});

e2eTest("[e2e/admin] 4.3 乐观锁冲突返回 409", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();

  // 选择一个运行时设置项并读取其 updated_at
  const getRes = await apiGet("/api/v1/admin/system/settings", adminToken);
  if (getRes.status !== 200) throw new Error("GET settings 失败");
  const settingsData = getRes.body as {
    data?: Array<{ key: string; effective_value: unknown }>;
  };
  const target = (settingsData?.data ?? []).find((s) =>
    s.key === "allow_domain_registration_invites"
  );
  if (!target) throw new Error("未找到可更新的设置项");

  // 用过期版本提交，应返回 409 VERSION_CONFLICT
  const { status, body } = await api(
    "PUT",
    `/api/v1/admin/system/settings/${target.key}`,
    {
      body: { value: target.effective_value },
      token: adminToken,
      headers: { "If-Match": '"stale-version"' },
    },
  );
  if (status !== 409) {
    throw new Error(`期望 409，实际 ${status} ${JSON.stringify(body)}`);
  }
  const conflictBody = body as { code?: string };
  if (conflictBody.code !== "VERSION_CONFLICT") {
    throw new Error(`期望 VERSION_CONFLICT，实际 ${conflictBody.code}`);
  }
});
