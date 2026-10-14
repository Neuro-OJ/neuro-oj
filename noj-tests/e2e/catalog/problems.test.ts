/**
 * 题目管理 E2E 测试。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  isE2E,
  publishProblemVersion,
  waitForServer,
} from "../helper.ts";

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
  if (status !== 201) throw new Error("创建失败: " + status);
  problemId = (body as { data: { id: string } }).data.id;
  if (!problemId) throw new Error("未返回 ID");
  await publishProblemVersion(adminToken, problemId, "e2e v1");
  console.log("  ✓ 创建题目: " + problemId.slice(0, 8));
});

e2eTest("[e2e/problems] 2.3 未认证创建被拒", async () => {
  if (!isE2E) return;
  const { status } = await apiPost("/api/v1/problems", {
    title: "Hack",
    description: "x",
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
  });
  if (status !== 401) throw new Error("期望 401");
  console.log("  ✓ 未认证创建被拒");
});

e2eTest("[e2e/problems] 2.4 管理员更新题目", async () => {
  if (!isE2E) return;
  const draft = await apiGet(`/api/v1/problems/${problemId}/draft`, adminToken);
  if (draft.status !== 200) throw new Error("读取更新基线失败");
  const revision = (draft.body as { data: { revision: number } }).data.revision;
  const { status, body } = await apiPut("/api/v1/problems/" + problemId, {
    title: "E2E v2",
    difficulty: "hard",
    expected_revision: revision,
  }, adminToken);
  if (status !== 200) throw new Error("更新失败: " + status);
  // 内容更新只写共享草稿，公开版本在发布前仍保持原内容（Handbook §6.2）。
  const d = body as { data: { difficulty: string } };
  if (d.data.difficulty !== "hard") throw new Error("管理信息未更新");
  const updatedDraft = await apiGet(
    `/api/v1/problems/${problemId}/draft`,
    adminToken,
  );
  const content =
    (updatedDraft.body as { data: { content: { title: string } } }).data
      .content;
  if (content.title !== "E2E v2") throw new Error("草稿标题未更新");
  const beforePublish = await apiGet(`/api/v1/problems/${problemId}`);
  if (
    beforePublish.status !== 200 ||
    (beforePublish.body as { data: { title: string } }).data.title !==
      "E2E 两数之和"
  ) {
    throw new Error("发布前公开题面没有保持 V1");
  }
  await publishProblemVersion(adminToken, problemId, "e2e v2");
  const afterPublish = await apiGet(
    "/api/v1/problems/" + problemId,
    adminToken,
  );
  const pub = afterPublish.body as { data: { title: string } };
  if (pub.data.title !== "E2E v2") throw new Error("发布后公开标题未更新");
  console.log("  ✓ 更新题目 + 发布 V2");
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

e2eTest("[e2e/problems] 2.8 已发布题目保护版本并停止公开", async () => {
  if (!isE2E) return;
  const { status } = await apiDelete(
    "/api/v1/problems/" + problemId,
    adminToken,
  );
  if (status !== 409) throw new Error("已发布题目删除应 409, 实际 " + status);
  const withdrawn = await apiPut(`/api/v1/problems/${problemId}/visibility`, {
    visibility: "private",
  }, adminToken);
  if (withdrawn.status !== 200) throw new Error("停止公开失败");
  const getRes = await apiGet("/api/v1/problems/" + problemId);
  if (getRes.status !== 404) throw new Error("停止公开后匿名应 404");
  const retained = await apiGet(
    `/api/v1/problems/${problemId}/versions`,
    adminToken,
  );
  if (retained.status !== 200) throw new Error("停止公开后历史版本应保留");
  console.log("  ✓ 版本保护与停止公开");
});
