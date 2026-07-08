/**
 * 题目管理 E2E 测试。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  getAdminToken,
  isE2E,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let adminToken = "";
let problemId = "";

Deno.test({
  name: "[e2e/problems] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
  },
});

Deno.test({
  name: "[e2e/problems] 2.1 公共列表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/problems");
    if (status !== 200) throw new Error("期望 200");
    const d = body as { data: unknown[]; total: number };
    if (!Array.isArray(d.data)) throw new Error("data 应为数组");
    console.log("  ✓ 题目公共列表 OK");
  },
});

Deno.test({
  name: "[e2e/problems] 2.2 管理员创建题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/problems", {
      title: "E2E 两数之和",
      description: "实现两数之和。",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 3000,
      memory_limit_mb: 256,
      type: "P",
    }, adminToken);
    if (status !== 201) throw new Error("创建失败: " + status);
    problemId = (body as { data: { id: string } }).data.id;
    if (!problemId) throw new Error("未返回 ID");
    console.log("  ✓ 创建题目: " + problemId.slice(0, 8));
  },
});

Deno.test({
  name: "[e2e/problems] 2.3 未认证创建被拒",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/problems", {
      title: "Hack",
      description: "x",
      judge_image: "img",
      judge_command: "cmd",
    });
    if (status !== 401) throw new Error("期望 401");
    console.log("  ✓ 未认证创建被拒");
  },
});

Deno.test({
  name: "[e2e/problems] 2.4 管理员更新题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut("/api/v1/problems/" + problemId, {
      title: "E2E v2",
      difficulty: "hard",
    }, adminToken);
    if (status !== 200) throw new Error("更新失败: " + status);
    const d = body as { data: { title: string; difficulty: string } };
    if (d.data.title !== "E2E v2") throw new Error("标题未更新");
    console.log("  ✓ 更新题目");
  },
});

Deno.test({
  name: "[e2e/problems] 2.5 按难度筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { body } = await apiGet("/api/v1/problems?difficulty=hard");
    const d = body as { data: { difficulty: string }[] };
    if (!d.data.every((p) => p.difficulty === "hard")) {
      throw new Error("含非 hard");
    }
    console.log("  ✓ 按难度筛选 OK");
  },
});

Deno.test({
  name: "[e2e/problems] 2.6 按关键词搜索",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { body } = await apiGet("/api/v1/problems?keyword=E2E");
    const d = body as { total: number };
    if (d.total < 1) throw new Error("应搜到结果");
    console.log("  ✓ 关键词搜索 OK");
  },
});

Deno.test({
  name: "[e2e/problems] 2.7 非法难度值",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/problems?difficulty=invalid");
    if (status !== 400) throw new Error("期望 400");
    console.log("  ✓ 非法难度 400");
  },
});

Deno.test({
  name: "[e2e/problems] 2.8 管理员删除题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiDelete(
      "/api/v1/problems/" + problemId,
      adminToken,
    );
    if (status !== 204) throw new Error("期望 204, 实际 " + status);
    const getRes = await apiGet("/api/v1/problems/" + problemId);
    if (getRes.status !== 404) throw new Error("删后应 404");
    console.log("  ✓ 删除题目");
  },
});
