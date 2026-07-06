/**
 * 用户主页 E2E 测试。
 */

import {
  apiGet,
  apiPut,
  isE2E,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let token = "";
let userId = "";

Deno.test({
  name: "[e2e/profile] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    token = await registerUser(
      "prof_user_" + ts,
      "prof_user_" + ts + "@test.com",
      "Pass1234Test",
    );
    const res = await apiGet("/api/v1/auth/me", token);
    userId = (res.body as { data: { id: string } }).data.id;
  },
});

Deno.test({
  name: "[e2e/profile] 5.1 查看用户主页",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet(
      "/api/v1/users/" + userId + "/profile",
    );
    if (status !== 200) throw new Error("期望 200");
    const d = body as {
      data: {
        user: { id: string };
        stats: object;
        solved_problems: unknown[];
        recent_submissions: unknown[];
      };
    };
    if (d.data.user.id !== userId) throw new Error("ID 不匹配");
    if (!Array.isArray(d.data.solved_problems)) {
      throw new Error("solved_problems 应数组");
    }
    console.log("  ✓ 用户主页 OK");
  },
});

Deno.test({
  name: "[e2e/profile] 5.2 不存在用户 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet(
      "/api/v1/users/nonexistent-id/profile",
    );
    if (status !== 404) throw new Error("期望 404");
    const d = body as { error: string };
    if (d.error !== "用户不存在") throw new Error("错误信息不匹配");
    console.log("  ✓ 不存在用户 404");
  },
});

Deno.test({
  name: "[e2e/profile] 5.3 主页无需认证",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/users/" + userId + "/profile");
    if (status !== 200) throw new Error("期望 200");
    console.log("  ✓ 主页无需认证");
  },
});

Deno.test({
  name: "[e2e/profile] 5.4 bio 默认为空",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet(
      "/api/v1/users/" + userId + "/profile",
    );
    if (status !== 200) throw new Error("期望 200");
    const d = body as { data: { user: { bio: string } } };
    if (d.data.user.bio !== "") throw new Error("bio 默认应空");
    console.log("  ✓ bio 默认为空");
  },
});

Deno.test({
  name: "[e2e/profile] 5.5 PUT 未认证 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut("/api/v1/users/me", { bio: "test" });
    if (status !== 401) throw new Error("期望 401");
    if ((body as { error: string }).error !== "未提供认证令牌") {
      throw new Error("错误信息不匹配");
    }
    console.log("  ✓ PUT 未认证 401");
  },
});

Deno.test({
  name: "[e2e/profile] 5.6 缺 bio 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut("/api/v1/users/me", {}, token);
    if (status !== 400) throw new Error("期望 400");
    if (!(body as { error: string }).error.includes("缺少必填字段")) {
      throw new Error("错误信息不匹配");
    }
    console.log("  ✓ 缺 bio 400");
  },
});

Deno.test({
  name: "[e2e/profile] 5.7 bio 超长 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut("/api/v1/users/me", {
      bio: "x".repeat(5001),
    }, token);
    if (status !== 400) throw new Error("期望 400");
    if (!(body as { error: string }).error.includes("不能超过")) {
      throw new Error("错误信息不匹配");
    }
    console.log("  ✓ bio 超长 400");
  },
});

Deno.test({
  name: "[e2e/profile] 5.8 更新 bio 成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const markdownBio = "# 自我介绍\n\n热爱 **算法竞赛**\n";
    const { status, body } = await apiPut("/api/v1/users/me", {
      bio: markdownBio,
    }, token);
    if (status !== 200) throw new Error("期望 200");
    if ((body as { data: { bio: string } }).data.bio !== markdownBio) {
      throw new Error("bio 未更新");
    }
    console.log("  ✓ 更新 bio");
  },
});

Deno.test({
  name: "[e2e/profile] 5.9 主页反映更新",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const expectedBio = "# 自我介绍\n\n热爱 **算法竞赛**\n";
    const { body } = await apiGet("/api/v1/users/" + userId + "/profile");
    if (
      (body as { data: { user: { bio: string } } }).data.user.bio !==
        expectedBio
    ) throw new Error("bio 不匹配");
    console.log("  ✓ 主页反映更新");
  },
});

Deno.test({
  name: "[e2e/profile] 5.10 清空 bio",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut(
      "/api/v1/users/me",
      { bio: "" },
      token,
    );
    if (status !== 200) throw new Error("期望 200");
    if ((body as { data: { bio: string } }).data.bio !== "") {
      throw new Error("bio 未清空");
    }
    const getRes = await apiGet("/api/v1/users/" + userId + "/profile");
    if (
      (getRes.body as { data: { user: { bio: string } } }).data.user.bio !== ""
    ) throw new Error("主页 bio 未清空");
    console.log("  ✓ 清空 bio");
  },
});
