/**
 * 固定角色权限 E2E 集成测试。
 *
 * 覆盖：
 * - 平台角色单值合同（PATCH role，拒绝 role_ids）
 * - 已删除的自定义角色/权限接口返回 404
 * - 域成员与 educator 的能力边界
 * - 注册用户默认普通角色
 */

import { api, e2eTest, getAdminToken, registerUser } from "../helper.ts";

e2eTest("rbac-e2e: 注册用户自动获得普通平台角色", async () => {
  const ts = Date.now();
  const token = await registerUser(
    `rbac_reg_${ts}`,
    `rbac_reg_${ts}@e2e.com`,
    "TestPass1234",
  );

  const meRes = await api("GET", "/api/v1/auth/me", { token });
  const me = (meRes.body as { data?: { is_admin?: boolean; role?: string } })
    .data;
  if (me?.is_admin !== false || me?.role !== "user") {
    throw new Error(`注册用户应为普通角色：${JSON.stringify(me)}`);
  }
});

e2eTest("rbac-e2e: 自定义角色与权限接口已删除", async () => {
  const adminToken = await getAdminToken();
  for (
    const [method, path] of [
      ["GET", "/api/v1/admin/identity/roles"],
      ["POST", "/api/v1/admin/identity/roles"],
      ["GET", "/api/v1/admin/identity/permissions"],
    ] as const
  ) {
    const response = await api(method, path, {
      token: adminToken,
      ...(method === "GET" ? {} : { body: { name: "legacy" } }),
    });
    if (response.status !== 404) {
      throw new Error(
        `${method} ${path} 应返回 404，实际 ${response.status}`,
      );
    }
  }
});

e2eTest("rbac-e2e: 平台角色只接受单值 role", async () => {
  const ts = Date.now();
  const adminToken = await getAdminToken();
  const token = await registerUser(
    `rbac_role_${ts}`,
    `rbac_role_${ts}@e2e.com`,
    "TestPass1234",
  );
  const me = await api("GET", "/api/v1/auth/me", { token });
  const userId = (me.body as { data: { id: string } }).data.id;

  const arrayBody = await api(
    "PATCH",
    `/api/v1/admin/identity/users/${userId}/role`,
    { token: adminToken, body: { role_ids: ["admin"] } },
  );
  if (arrayBody.status !== 400) {
    throw new Error(`role_ids 必须 400，实际 ${arrayBody.status}`);
  }

  const promoted = await api(
    "PATCH",
    `/api/v1/admin/identity/users/${userId}/role`,
    { token: adminToken, body: { role: "admin" } },
  );
  if (promoted.status !== 200) {
    throw new Error(`提升管理员失败：${JSON.stringify(promoted.body)}`);
  }
  const afterMe = await api("GET", "/api/v1/auth/me", { token });
  if (
    (afterMe.body as { data: { is_admin?: boolean } }).data.is_admin !== true
  ) {
    throw new Error("提升后 /auth/me 的 is_admin 必须为 true");
  }

  const demoted = await api(
    "PATCH",
    `/api/v1/admin/identity/users/${userId}/role`,
    { token: adminToken, body: { role: "user" } },
  );
  if (demoted.status !== 200) {
    throw new Error(`降权失败：${JSON.stringify(demoted.body)}`);
  }
});

e2eTest("rbac-e2e: 普通用户无法访问管理 API", async () => {
  const ts = Date.now();
  const token = await registerUser(
    `rbac_noadmin_${ts}`,
    `rbac_noadmin_${ts}@e2e.com`,
    "TestPass1234",
  );

  const usersRes = await api("GET", "/api/v1/admin/identity/users", { token });

  if (usersRes.status !== 403 && usersRes.status !== 401) {
    throw new Error(
      `普通用户访问管理 API 应返回 401/403，实际 ${usersRes.status}`,
    );
  }
});

e2eTest(
  "rbac-e2e: 域成员不可建题，educator 可建题但仍受实例敏感字段约束",
  async () => {
    const ts = Date.now();
    const token = await registerUser(
      `rbac_puser_${ts}`,
      `rbac_puser_${ts}@e2e.com`,
      "TestPass1234",
    );

    // 统一账号本身不授予当前域题库编辑权限。
    const createRes = await api("POST", "/api/v1/domains/main/problems", {
      token,
      body: {
        title: "E2E 域成员建题权限",
        description: "Should be forbidden",
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
      },
    });

    if (createRes.status !== 403) {
      throw new Error(`普通成员建题应返回403：${JSON.stringify(createRes)}`);
    }
    const admin = await getAdminToken();
    const invited = await api("POST", "/api/v1/domains/main/invitations", {
      token: admin,
      body: { email: `rbac_puser_${ts}@e2e.com` },
    });
    if (invited.status !== 201) {
      throw new Error(`邀请成员失败 ${JSON.stringify(invited)}`);
    }
    const accepted = await api("POST", "/api/v1/domain-invitations/accept", {
      token,
      body: { token: (invited.body as { data: { token: string } }).data.token },
    });
    if (accepted.status !== 200) {
      throw new Error(`加入默认域失败 ${JSON.stringify(accepted)}`);
    }
    const me = await api("GET", "/api/v1/auth/me", { token });
    const userId = (me.body as { data: { id: string } }).data.id;
    const assigned = await api(
      "PUT",
      `/api/v1/domains/main/members/${userId}/role`,
      {
        token: admin,
        body: { role: "educator" },
      },
    );
    if (assigned.status !== 200) {
      throw new Error(`educator 授权失败 ${JSON.stringify(assigned)}`);
    }
    // 已具有当前域资源编辑权限，非默认 evaluator.command 仍需要平台授权。
    const uRes = await api("POST", "/api/v1/domains/main/problems", {
      token,
      body: {
        title: "E2E 编辑者敏感字段权限",
        description: "Should be forbidden for sensitive fields",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "bash /workspace/run.sh",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });

    if (uRes.status !== 403) {
      throw new Error(
        `域 educator 创建含敏感字段的题应被拒，实际 ${uRes.status}: ${
          JSON.stringify(uRes.body)
        }`,
      );
    }
  },
);
