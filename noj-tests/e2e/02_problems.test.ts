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
  e2eTest,

} from "./helper.ts";

let adminToken = "";
let problemId = "";

e2eTest("[e2e/problems] Setup", async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
  });

e2eTest("[e2e/problems] 2.1 公共列表", async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/problems");
    if (status !== 200) throw new Error("期望 200");
    const d = body as { data: unknown[]; total: number };
    if (!Array.isArray(d.data)) throw new Error("data 应为数组");
    console.log("  ✓ 题目公共列表 OK");
  });

e2eTest("[e2e/problems] 2.2 管理员创建题目", async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/problems", {
      title: "E2E 两数之和",
      description: "实现两数之和。",
      difficulty: "easy",
      runtime_config: {

        evaluator: { image: "noj-evaluator-python", command: "python3 /workspace/evaluate.py", time_limit_ms: 5000, memory_limit_mb: 512 },

        solution: { image: "noj-solution-python", call_timeout_ms: 2000, memory_limit_mb: 512 },

      },
      type: "P",
    }, adminToken);
    if (status !== 201) throw new Error("创建失败: " + status);
    problemId = (body as { data: { id: string } }).data.id;
    if (!problemId) throw new Error("未返回 ID");
    console.log("  ✓ 创建题目: " + problemId.slice(0, 8));
  });

e2eTest("[e2e/problems] 2.3 未认证创建被拒", async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/problems", {
      title: "Hack",
      description: "x",
      runtime_config: {

        evaluator: { image: "noj-evaluator-python", command: "python3 /workspace/evaluate.py", time_limit_ms: 5000, memory_limit_mb: 512 },

        solution: { image: "noj-solution-python", call_timeout_ms: 2000, memory_limit_mb: 512 },

      },
    });
    if (status !== 401) throw new Error("期望 401");
    console.log("  ✓ 未认证创建被拒");
  });

e2eTest("[e2e/problems] 2.4 管理员更新题目", async () => {
    if (!isE2E) return;
    const { status, body } = await apiPut("/api/v1/problems/" + problemId, {
      title: "E2E v2",
      difficulty: "hard",
    }, adminToken);
    if (status !== 200) throw new Error("更新失败: " + status);
    const d = body as { data: { title: string; difficulty: string } };
    if (d.data.title !== "E2E v2") throw new Error("标题未更新");
    console.log("  ✓ 更新题目");
  });

e2eTest("[e2e/problems] 2.5 按难度筛选", async () => {
    if (!isE2E) return;
    const { body } = await apiGet("/api/v1/problems?difficulty=hard");
    const d = body as { data: { difficulty: string }[] };
    if (!d.data.every((p) => p.difficulty === "hard")) {
      throw new Error("含非 hard");
    }
    console.log("  ✓ 按难度筛选 OK");
  });

e2eTest("[e2e/problems] 2.6 按关键词搜索", async () => {
    if (!isE2E) return;
    const { body } = await apiGet("/api/v1/problems?keyword=E2E");
    const d = body as { total: number };
    if (d.total < 1) throw new Error("应搜到结果");
    console.log("  ✓ 关键词搜索 OK");
  });

e2eTest("[e2e/problems] 2.7 非法难度值", async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/problems?difficulty=invalid");
    if (status !== 400) throw new Error("期望 400");
    console.log("  ✓ 非法难度 400");
  });

e2eTest("[e2e/problems] 2.8 管理员删除题目", async () => {
    if (!isE2E) return;
    const { status } = await apiDelete(
      "/api/v1/problems/" + problemId,
      adminToken,
    );
    if (status !== 204) throw new Error("期望 204, 实际 " + status);
    const getRes = await apiGet("/api/v1/problems/" + problemId);
    if (getRes.status !== 404) throw new Error("删后应 404");
    console.log("  ✓ 删除题目");
  });
