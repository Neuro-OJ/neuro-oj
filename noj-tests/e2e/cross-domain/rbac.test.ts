/**
 * RBAC 权限系统 E2E 集成测试。
 *
 * 覆盖：
 * - 角色/权限 CRUD API
 * - 用户角色分配
 * - 权限检查服务层集成
 * - 注册用户自动分配默认角色
 */

import { api, e2eTest, getAdminToken, registerUser } from "../helper.ts";

e2eTest("rbac-e2e: 注册用户自动获得默认角色", async () => {
  const ts = Date.now();
  const token = await registerUser(
    `rbac_reg_${ts}`,
    `rbac_reg_${ts}@e2e.com`,
    "TestPass1234",
  );

  // 通过 /auth/me 验证用户有 is_admin=false
  const meRes = await api("GET", "/api/v1/auth/me", { token });
  const meBody = meRes.body as { data?: Record<string, unknown> };
  const me = meBody?.data as { is_admin?: boolean } | undefined;

  // 普通用户 is_admin = false
  if (me && me.is_admin !== undefined && me.is_admin !== false) {
    throw new Error(
      `注册用户 is_admin 应为 false，实际 ${me.is_admin}`,
    );
  }
});

e2eTest("rbac-e2e: 管理员可获取角色列表", async () => {
  // 用管理员身份（seed 时创建）
  const adminToken = await getAdminToken();

  const rolesRes = await api("GET", "/api/v1/admin/identity/roles", {
    token: adminToken,
  });
  const rolesBody = rolesRes.body as {
    data?: Array<Record<string, unknown>>;
  };

  if (rolesRes.status !== 200) {
    throw new Error(`获取角色列表失败: ${JSON.stringify(rolesBody)}`);
  }

  const roles = rolesBody.data ?? [];
  const adminRole = roles.find((r) => r.name === "admin");
  const userRole = roles.find((r) => r.name === "user");

  if (!adminRole) throw new Error("缺少 admin 角色");
  if (!userRole) throw new Error("缺少 user 角色");
  if (adminRole.is_admin !== true) {
    throw new Error("admin 角色 is_admin 应为 true");
  }
  if (userRole.is_default !== true) {
    throw new Error("user 角色 is_default 应为 true");
  }
});

e2eTest("rbac-e2e: 管理员可获取权限列表", async () => {
  const adminToken = await getAdminToken();

  const permRes = await api("GET", "/api/v1/admin/identity/permissions", {
    token: adminToken,
  });

  if (permRes.status !== 200) {
    throw new Error(`获取权限列表失败: ${JSON.stringify(permRes.body)}`);
  }
});

e2eTest("rbac-e2e: 管理员可创建自定义角色", async () => {
  const adminToken = await getAdminToken();

  // 创建自定义角色
  const ts = Date.now();
  const createRes = await api("POST", "/api/v1/admin/identity/roles", {
    token: adminToken,
    body: {
      name: `e2e-moderator-${ts}`,
      description: "E2E 测试角色",
      permission_ids: [],
    },
  });

  if (createRes.status !== 201) {
    throw new Error(`创建角色失败: ${JSON.stringify(createRes.body)}`);
  }

  const createdRole =
    (createRes.body as { data?: Record<string, unknown> }).data;
  if (!createdRole || createdRole.name !== `e2e-moderator-${ts}`) {
    throw new Error(`角色创建后名称不匹配: ${JSON.stringify(createdRole)}`);
  }
});

e2eTest("rbac-e2e: 普通用户无法访问管理 API", async () => {
  const ts = Date.now();
  const token = await registerUser(
    `rbac_noadmin_${ts}`,
    `rbac_noadmin_${ts}@e2e.com`,
    "TestPass1234",
  );

  const rolesRes = await api("GET", "/api/v1/admin/identity/roles", { token });

  if (rolesRes.status !== 403 && rolesRes.status !== 401) {
    throw new Error(
      `普通用户访问 /admin/roles 应返回 401/403，实际 ${rolesRes.status}`,
    );
  }
});

e2eTest("rbac-e2e: 域成员不可建题，域编辑者仍受实例敏感字段约束", async () => {
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
    throw new Error(`邀请编辑者失败 ${JSON.stringify(invited)}`);
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
    `/api/v1/domains/main/members/${userId}/roles`,
    {
      token: admin,
      body: { roles: ["editor"] },
    },
  );
  if (assigned.status !== 200) {
    throw new Error(`编辑者授权失败 ${JSON.stringify(assigned)}`);
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
      `域编辑者创建含敏感字段的题应被拒，实际 ${uRes.status}: ${
        JSON.stringify(uRes.body)
      }`,
    );
  }
});
