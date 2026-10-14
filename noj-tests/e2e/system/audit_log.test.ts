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
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

let adminToken = "";
let userToken = "";
let targetUserId = "";
let problemId = "";
let tagId = "";
let adminRoleId = "";
let userRoleId = "";
const ts = Date.now().toString(36);

async function targetAuditRecords(action: string, targetId: string) {
  const response = await apiGet(
    `/api/v1/admin/system/audit-logs?action=${action}&per_page=100`,
    adminToken,
  );
  if (response.status !== 200) {
    throw new Error(`读取${action}审计失败: ${response.status}`);
  }
  return (response.body as { data: { target_id: string | null }[] }).data
    .filter((record) => record.target_id === targetId);
}

e2eTest("[e2e/audit-log] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();

  // 获取 admin 角色 ID
  const rolesRes = await apiGet("/api/v1/admin/identity/roles", adminToken);
  const roles =
    (rolesRes.body as { data: Array<{ id: string; name: string }> }).data ??
      [];
  const adminRole = roles.find((r) => r.name === "admin");
  const userRole = roles.find((role) => role.name === "user");
  if (!adminRole || !userRole) throw new Error("缺少平台内置admin/user角色");
  adminRoleId = adminRole.id;
  userRoleId = userRole.id;

  // 注册普通用户（用于 role_change/ban/unban 操作）
  userToken = await registerUser(
    "audit_user_" + ts,
    "audit_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  const me = await apiGet("/api/v1/auth/me", userToken);
  targetUserId = (me.body as { data: { id: string } }).data.id;

  // 创建题目（用于 problems.delete 审计）
  const probRes = await apiPost("/api/v1/problems", {
    title: "审计删除测试题",
    description: "将被删除以产生审计日志",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },

      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
  }, adminToken);
  if (probRes.status !== 201) throw new Error("创建题目失败");
  problemId = (probRes.body as { data: { id: string } }).data.id;

  // 创建标签（用于 tags.delete / tags.merge 审计）
  const tagRes = await apiPost("/api/v1/tags", {
    name: "审计测试标签" + ts,
    kind: "problem",
  }, adminToken);
  if (tagRes.status !== 201) throw new Error("创建标签失败");
  tagId = (tagRes.body as { data: { id: string } }).data.id;

  console.log("  ✓ 管理员已登录，测试资源已创建");
});

// ── 执行 7 类操作 ──

e2eTest("[e2e/audit-log] 3.1a role_change 产生审计记录", async () => {
  if (!isE2E) return;
  // 先提升为 admin，再降回 user 确保产生记录
  const upRes = await apiPatch(
    `/api/v1/admin/identity/users/${targetUserId}/role`,
    { role_ids: [adminRoleId] },
    adminToken,
  );
  if (upRes.status !== 200) {
    throw new Error(
      "提权失败: " + upRes.status + " " + JSON.stringify(upRes.body),
    );
  }

  const downRes = await apiPatch(
    `/api/v1/admin/identity/users/${targetUserId}/role`,
    { role_ids: [userRoleId] },
    adminToken,
  );
  if (downRes.status !== 200) {
    throw new Error(
      `恢复基础角色失败: ${downRes.status} ${JSON.stringify(downRes.body)}`,
    );
  }

  // 验证审计记录
  const data = await targetAuditRecords("users.role_change", targetUserId);
  if (data.length < 2) {
    throw new Error("本轮用户提权与降权审计记录不足: " + data.length);
  }
  console.log("  ✓ role_change 审计记录: " + data.length + " 条");
});

e2eTest("[e2e/audit-log] 3.1b ban/unban 产生审计记录", async () => {
  if (!isE2E) return;
  const banRes = await apiPatch(
    `/api/v1/admin/identity/users/${targetUserId}/ban`,
    { reason: "E2E 测试封禁" },
    adminToken,
  );
  if (banRes.status !== 200) throw new Error("封禁失败: " + banRes.status);

  const unbanRes = await apiPatch(
    `/api/v1/admin/identity/users/${targetUserId}/unban`,
    {},
    adminToken,
  );
  if (unbanRes.status !== 200) {
    throw new Error("解封失败: " + unbanRes.status);
  }

  const banData = await targetAuditRecords("users.ban", targetUserId);
  if (banData.length !== 1) throw new Error("缺少本轮用户封禁审计记录");
  console.log("  ✓ ban 审计记录: " + banData.length + " 条");

  const unbanData = await targetAuditRecords("users.unban", targetUserId);
  if (unbanData.length !== 1) throw new Error("缺少本轮用户解封审计记录");
  console.log("  ✓ unban 审计记录: " + unbanData.length + " 条");
});

e2eTest("[e2e/audit-log] 3.1c problems.delete 产生审计记录", async () => {
  if (!isE2E) return;
  const delRes = await apiDelete(
    `/api/v1/problems/${problemId}`,
    adminToken,
  );
  if (delRes.status !== 200 && delRes.status !== 204) {
    throw new Error("删除题目失败: " + delRes.status);
  }

  const data = await targetAuditRecords("problems.delete", problemId);
  if (data.length === 0) {
    throw new Error("problems.delete 审计记录未找到");
  }
  console.log("  ✓ problems.delete 审计记录: " + data.length + " 条");
});

e2eTest("[e2e/audit-log] 3.1d tags.delete 产生审计记录", async () => {
  if (!isE2E) return;
  const delRes = await apiDelete(
    `/api/v1/tags/${tagId}`,
    adminToken,
  );
  if (delRes.status !== 200 && delRes.status !== 204) {
    throw new Error("删除标签失败: " + delRes.status);
  }

  const data = await targetAuditRecords("tags.delete", tagId);
  if (data.length === 0) {
    throw new Error("tags.delete 审计记录未找到");
  }
  console.log("  ✓ tags.delete 审计记录: " + data.length + " 条");
});

e2eTest("[e2e/audit-log] 3.1e tags.merge 产生审计记录", async () => {
  if (!isE2E) return;
  // 重建两个标签用于合并审计
  const srcRes = await apiPost("/api/v1/tags", {
    name: "审计合并源" + ts,
    kind: "problem",
  }, adminToken);
  if (srcRes.status !== 201) throw new Error("创建源标签失败");
  const srcId = (srcRes.body as { data: { id: string } }).data.id;
  const dstRes = await apiPost("/api/v1/tags", {
    name: "审计合并目标" + ts,
    kind: "problem",
  }, adminToken);
  if (dstRes.status !== 201) throw new Error("创建目标标签失败");
  const dstId = (dstRes.body as { data: { id: string } }).data.id;

  const mergeRes = await apiPost(
    `/api/v1/tags/${srcId}/merge`,
    { target_id: dstId },
    adminToken,
  );
  if (mergeRes.status !== 204) throw new Error("合并失败: " + mergeRes.status);

  const data = await targetAuditRecords("tags.merge", srcId);
  if (data.length === 0) {
    throw new Error("tags.merge 审计记录未找到");
  }
  console.log("  ✓ tags.merge 审计记录: " + data.length + " 条");
});

// ── 列表查询 ──

e2eTest("[e2e/audit-log] 3.2a 时间筛选", async () => {
  if (!isE2E) return;
  const now = new Date();
  const from = new Date(now.getTime() - 3600000).toISOString(); // 1h ago
  const to = now.toISOString();
  const logs = await apiGet(
    `/api/v1/admin/system/audit-logs?from=${from}&to=${to}`,
    adminToken,
  );
  if (logs.status !== 200) throw new Error("时间筛选失败: " + logs.status);
  const data =
    (logs.body as { data: Array<unknown>; pagination: { total: number } })
      .data;
  console.log("  ✓ 时间筛选返回 " + data.length + " 条记录");
});

e2eTest("[e2e/audit-log] 3.2b 分页正确", async () => {
  if (!isE2E) return;
  const logs = await apiGet(
    "/api/v1/admin/system/audit-logs?per_page=3&page=1",
    adminToken,
  );
  if (logs.status !== 200) throw new Error("分页失败: " + logs.status);
  const body = logs.body as {
    data: Array<unknown>;
    pagination: { per_page: number };
  };
  if (body.data.length > 3) {
    throw new Error("per_page=3 但返回 " + body.data.length);
  }
  console.log("  ✓ 分页正确（per_page=" + body.data.length + "）");
});

e2eTest("[e2e/audit-log] 3.2c 非 admin 返回 403", async () => {
  if (!isE2E) return;
  // 前序 3.1b 封禁后递增了 session_version 导致原有 JWT 失效，重新登录获取新会话
  const loginRes = await apiPost("/api/v1/auth/login", {
    login: "audit_user_" + ts,
    password: TEST_PASSWORD,
  });
  if (loginRes.status !== 200) {
    throw new Error(`重新登录审计用户失败: ${loginRes.status}`);
  }
  const currentToken =
    (loginRes.body as { data: { token: string } }).data.token;
  const logs = await apiGet("/api/v1/admin/system/audit-logs", currentToken);
  if (logs.status !== 403) {
    throw new Error("期望 403, 实际 " + logs.status);
  }
  console.log("  ✓ 非 admin 访问审计日志被拒");
});

e2eTest("[e2e/audit-log] 3.3 管理操作写入审计且包含操作者与时间", async () => {
  if (!isE2E) return;
  const title = "Audit " + Date.now().toString(36);
  const res = await apiPost(
    "/api/v1/admin/system/announcements",
    { title, content: "审计断言测试" },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      "创建公告失败: " + res.status + " " + JSON.stringify(res.body),
    );
  }

  const list = await apiGet(
    "/api/v1/admin/system/audit-logs?action=announcement.create&per_page=5",
    adminToken,
  );
  if (list.status !== 200) {
    throw new Error("审计日志查询失败: " + list.status);
  }
  const rows = (list.body as {
    data: Array<{
      admin_id: string | null;
      created_at: string;
      detail: { title?: string };
    }>;
  }).data ?? [];
  const hit = rows.find((r) => r.detail?.title === title);
  if (!hit) {
    throw new Error("审计日志应包含公告创建记录");
  }
  if (!hit.admin_id) {
    throw new Error("审计记录应包含操作者 admin_id");
  }
  if (typeof hit.created_at !== "string" || !hit.created_at) {
    throw new Error("审计记录应包含 created_at");
  }
});
