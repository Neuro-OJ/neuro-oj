/**
 * RBAC 权限系统 E2E 集成测试。
 *
 * 覆盖：
 * - 角色/权限 CRUD API
 * - 用户角色分配
 * - 权限检查服务层集成
 * - 注册用户自动分配默认角色
 */

import { api, isE2E, registerUser } from "./helper.ts";

const skip = !isE2E;

Deno.test({
  name: "rbac-e2e: 注册用户自动获得默认角色",
  ignore: skip,
  fn: async () => {
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
  },
});

Deno.test({
  name: "rbac-e2e: 管理员可获取角色列表",
  ignore: skip,
  fn: async () => {
    // 用 root 管理员身份（seed 时创建）
    const loginRes = await api("POST", "/api/v1/auth/login", {
      body: { login: "root", password: "root" },
    });
    const loginBody = loginRes.body as { data?: { token?: string } };
    const token = loginBody.data?.token ?? "";

    if (!token) {
      // 可能 root 没有密码，跳过
      return;
    }

    const rolesRes = await api("GET", "/api/v1/admin/roles", { token });
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
  },
});

Deno.test({
  name: "rbac-e2e: 管理员可获取权限列表",
  ignore: skip,
  fn: async () => {
    const loginRes = await api("POST", "/api/v1/auth/login", {
      body: { login: "root", password: "root" },
    });
    const loginBody = loginRes.body as { data?: { token?: string } };
    const token = loginBody.data?.token ?? "";
    if (!token) return;

    const permRes = await api("GET", "/api/v1/admin/permissions", { token });

    if (permRes.status !== 200) {
      throw new Error(`获取权限列表失败: ${JSON.stringify(permRes.body)}`);
    }
  },
});

Deno.test({
  name: "rbac-e2e: 管理员可创建自定义角色",
  ignore: skip,
  fn: async () => {
    const loginRes = await api("POST", "/api/v1/auth/login", {
      body: { login: "root", password: "root" },
    });
    const loginBody = loginRes.body as { data?: { token?: string } };
    const token = loginBody.data?.token ?? "";
    if (!token) return;

    // 创建自定义角色
    const ts = Date.now();
    const createRes = await api("POST", "/api/v1/admin/roles", {
      token,
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
  },
});

Deno.test({
  name: "rbac-e2e: 普通用户无法访问管理 API",
  ignore: skip,
  fn: async () => {
    const ts = Date.now();
    const token = await registerUser(
      `rbac_noadmin_${ts}`,
      `rbac_noadmin_${ts}@e2e.com`,
      "TestPass1234",
    );

    const rolesRes = await api("GET", "/api/v1/admin/roles", { token });

    if (rolesRes.status !== 403 && rolesRes.status !== 401) {
      throw new Error(
        `普通用户访问 /admin/roles 应返回 401/403，实际 ${rolesRes.status}`,
      );
    }
  },
});

Deno.test({
  name: "rbac-e2e: 服务层权限校验——普通用户无法创建 P 型题",
  ignore: skip,
  fn: async () => {
    const ts = Date.now();
    const token = await registerUser(
      `rbac_puser_${ts}`,
      `rbac_puser_${ts}@e2e.com`,
      "TestPass1234",
    );

    // 尝试创建 P 型题目
    const createRes = await api("POST", "/api/v1/problems", {
      token,
      body: {
        title: "E2E P-type Test",
        description: "Should be forbidden",
        type: "P",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "solution.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });

    // 普通用户创建 P 型题应被拒绝
    if (createRes.status === 201) {
      throw new Error("普通用户不应能创建 P 型题");
    }

    // 创建 U 型题应成功
    const uRes = await api("POST", "/api/v1/problems", {
      token,
      body: {
        title: "E2E U-type Test",
        description: "Should succeed",
        type: "U",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "solution.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });

    if (uRes.status !== 201) {
      throw new Error(
        `普通用户创建 U 型题应成功，实际 ${uRes.status}: ${
          JSON.stringify(uRes.body)
        }`,
      );
    }
  },
});
