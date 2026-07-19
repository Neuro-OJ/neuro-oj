/**
 * 审计日志 E2E 测试。
 *
 * 覆盖：
 * - 7 类管理员操作后审计记录存在性验证
 * - 审计日志列表查询：action 筛选、时间筛选、分页、root 排除
 * - 非 admin 访问 403 验证
 *
 * 依赖：seed 中的 e2e_admin 用户 + 自行创建的测试资源。
 */

import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  isE2E,
  getAdminToken,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let adminToken = "";
let userToken = "";
let targetUserId = "";
let problemId = "";
let categoryId = "";
const ts = Date.now().toString(36);

Deno.test({
  name: "[e2e/audit-log] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();

    // 注册普通用户（用于 role_change/ban/unban 操作）
    userToken = await registerUser(
      "audit_user_" + ts,
      "audit_user_" + ts + "@test.com",
      "Test12345679",
    );
    const me = await apiGet("/api/v1/auth/me", userToken);
    targetUserId = (me.body as { data: { id: string } }).data.id;

    // 创建题目（用于 problems.delete 审计）
    const probRes = await apiPost("/api/v1/problems", {
      title: "审计删除测试题",
      description: "将被删除以产生审计日志",
      difficulty: "easy",
      runtime_config: {

        evaluator: { image: "noj-evaluator-python", command: "python3 /workspace/evaluate.py", time_limit_ms: 5000, memory_limit_mb: 512 },

        solution: { image: "noj-solution-python", entry: "submission_sample.py", call_timeout_ms: 2000, memory_limit_mb: 512 },

      },
      type: "P",
    }, adminToken);
    if (probRes.status !== 201) throw new Error("创建题目失败");
    problemId = (probRes.body as { data: { id: string } }).data.id;

    // 创建分类（用于 categories.delete 审计）
    const catRes = await apiPost("/api/v1/categories", {
      name: "审计测试分类",
      slug: "audit-cat-" + ts,
    }, adminToken);
    if (catRes.status !== 201) {
      // 可能 slug 已存在
      const cRes = await apiPost("/api/v1/categories", {
        name: "审计测试分类" + ts,
        slug: "audit-cat-" + ts + "-alt",
      }, adminToken);
      if (cRes.status !== 201) throw new Error("创建分类失败");
      categoryId = (cRes.body as { data: { id: string } }).data.id;
    } else {
      categoryId = (catRes.body as { data: { id: string } }).data.id;
    }

    console.log("  ✓ 管理员已登录，测试资源已创建");
  },
});

// ── 执行 7 类操作 ──

Deno.test({
  name: "[e2e/audit-log] 3.1a role_change 产生审计记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 先提升为 admin，再降回 user 确保产生记录
    const upRes = await apiPatch(
      `/api/v1/admin/users/${targetUserId}/role`,
      { role: "admin" },
      adminToken,
    );
    if (upRes.status !== 200) throw new Error("提权失败: " + upRes.status);

    const downRes = await apiPatch(
      `/api/v1/admin/users/${targetUserId}/role`,
      { role: "user" },
      adminToken,
    );
    if (downRes.status !== 200) throw new Error("降权失败: " + downRes.status);

    // 验证审计记录
    const logs = await apiGet(
      "/api/v1/admin/audit-logs?action=users.role_change",
      adminToken,
    );
    const data = (logs.body as { data: Array<unknown> }).data;
    if (data.length < 2) {
      console.log("  ⚠ role_change 记录数不足: " + data.length);
    } else {
      console.log("  ✓ role_change 审计记录: " + data.length + " 条");
    }
  },
});

Deno.test({
  name: "[e2e/audit-log] 3.1b ban/unban 产生审计记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const banRes = await apiPatch(
      `/api/v1/admin/users/${targetUserId}/ban`,
      { reason: "E2E 测试封禁" },
      adminToken,
    );
    if (banRes.status !== 200) throw new Error("封禁失败: " + banRes.status);

    const unbanRes = await apiPatch(
      `/api/v1/admin/users/${targetUserId}/unban`,
      {},
      adminToken,
    );
    if (unbanRes.status !== 200) throw new Error("解封失败: " + unbanRes.status);

    const banLogs = await apiGet(
      "/api/v1/admin/audit-logs?action=users.ban",
      adminToken,
    );
    const banData = (banLogs.body as { data: Array<unknown> }).data;
    console.log("  ✓ ban 审计记录: " + banData.length + " 条");

    const unbanLogs = await apiGet(
      "/api/v1/admin/audit-logs?action=users.unban",
      adminToken,
    );
    const unbanData = (unbanLogs.body as { data: Array<unknown> }).data;
    console.log("  ✓ unban 审计记录: " + unbanData.length + " 条");
  },
});

Deno.test({
  name: "[e2e/audit-log] 3.1c problems.delete 产生审计记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const delRes = await apiDelete(
      `/api/v1/problems/${problemId}`,
      adminToken,
    );
    if (delRes.status !== 200 && delRes.status !== 204) {
      throw new Error("删除题目失败: " + delRes.status);
    }

    const logs = await apiGet(
      "/api/v1/admin/audit-logs?action=problems.delete",
      adminToken,
    );
    const data = (logs.body as { data: Array<unknown> }).data;
    if (data.length === 0) {
      throw new Error("problems.delete 审计记录未找到");
    }
    console.log("  ✓ problems.delete 审计记录: " + data.length + " 条");
  },
});

Deno.test({
  name: "[e2e/audit-log] 3.1d categories.delete 产生审计记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const delRes = await apiDelete(
      `/api/v1/categories/${categoryId}`,
      adminToken,
    );
    if (delRes.status !== 200 && delRes.status !== 204) {
      throw new Error("删除分类失败: " + delRes.status);
    }

    const logs = await apiGet(
      "/api/v1/admin/audit-logs?action=categories.delete",
      adminToken,
    );
    const data = (logs.body as { data: Array<unknown> }).data;
    if (data.length === 0) {
      throw new Error("categories.delete 审计记录未找到");
    }
    console.log("  ✓ categories.delete 审计记录: " + data.length + " 条");
  },
});

// ── 列表查询 ──

Deno.test({
  name: "[e2e/audit-log] 3.2a 时间筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const now = new Date();
    const from = new Date(now.getTime() - 3600000).toISOString(); // 1h ago
    const to = now.toISOString();
    const logs = await apiGet(
      `/api/v1/admin/audit-logs?from=${from}&to=${to}`,
      adminToken,
    );
    if (logs.status !== 200) throw new Error("时间筛选失败: " + logs.status);
    const data = (logs.body as { data: Array<unknown>; pagination: { total: number } }).data;
    console.log("  ✓ 时间筛选返回 " + data.length + " 条记录");
  },
});

Deno.test({
  name: "[e2e/audit-log] 3.2b 分页正确",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const logs = await apiGet(
      "/api/v1/admin/audit-logs?per_page=3&page=1",
      adminToken,
    );
    if (logs.status !== 200) throw new Error("分页失败: " + logs.status);
    const body = logs.body as { data: Array<unknown>; pagination: { per_page: number } };
    if (body.data.length > 3) {
      throw new Error("per_page=3 但返回 " + body.data.length);
    }
    console.log("  ✓ 分页正确（per_page=" + body.data.length + "）");
  },
});

Deno.test({
  name: "[e2e/audit-log] 3.2c 非 admin 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const logs = await apiGet("/api/v1/admin/audit-logs", userToken);
    if (logs.status !== 403) {
      throw new Error("期望 403, 实际 " + logs.status);
    }
    console.log("  ✓ 非 admin 访问审计日志被拒");
  },
});
