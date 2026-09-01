/**
 * 标签系统 E2E 测试（issue #223：category 退役，双类标签取代）。
 *
 * 覆盖：标签 CRUD/合并/删除清理、打标签与 ?tag= 筛选、组合筛选、
 * 算法标签可视性门控（匿名/未通过隐藏、AC 后可见）。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
  getProblemIdByNumber,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  submitCode,
  waitForServer,
} from "./helper.ts";

let adminToken = "";
let tagId = "";
let algorithmTagId = "";
let problemId = "";
let gatingProblemId = "";

e2eTest("[e2e/tags] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  console.log("  ✓ 管理员已登录并完成强制改密");
});

e2eTest("[e2e/tags] 1.1 GET 标签列表", async () => {
  if (!isE2E) return;
  const { status, body } = await apiGet("/api/v1/tags");
  if (status !== 200) throw new Error("期望 200");
  const d = body as { data: unknown[] };
  if (!Array.isArray(d.data)) throw new Error("data 应为数组");
  for (const item of d.data as Record<string, unknown>[]) {
    if (
      typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.kind !== "string" || typeof item.problem_count !== "number"
    ) {
      throw new Error("标签项字段不完整");
    }
  }
  console.log("  ✓ 标签列表正常");
});

e2eTest("[e2e/tags] 1.2 管理员创建题目标签与算法标签", async () => {
  if (!isE2E) return;
  const name = "E2E 标签 " + Date.now().toString(36);
  const res = await apiPost(
    "/api/v1/tags",
    { name, kind: "problem" },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error("创建题目标签失败: " + res.status);
  }
  tagId = (res.body as { data: { id: string } }).data.id;

  const algoName = "E2E 算法 " + Date.now().toString(36);
  const algoRes = await apiPost(
    "/api/v1/tags",
    { name: algoName, kind: "algorithm" },
    adminToken,
  );
  if (algoRes.status !== 201) {
    throw new Error("创建算法标签失败: " + algoRes.status);
  }
  algorithmTagId = (algoRes.body as { data: { id: string } }).data.id;
  console.log("  ✓ 创建双类标签");
});

e2eTest("[e2e/tags] 1.3 未认证创建标签被拒", async () => {
  if (!isE2E) return;
  const { status } = await apiPost("/api/v1/tags", {
    name: "Hack " + Date.now().toString(36),
    kind: "problem",
  });
  if (status !== 401) throw new Error("期望 401, 实际 " + status);
  console.log("  ✓ 未认证创建标签被拒");
});

e2eTest("[e2e/tags] 1.4 普通用户创建标签被拒（默认仅 admin）", async () => {
  if (!isE2E) return;
  const { token } = await getOrCreateUser(
    "e2e_tag_user",
    "e2e_tag_user",
    "e2e_tag_user@e2e.local",
  );
  if (!token) throw new Error("获取普通用户失败");
  const { status } = await apiPost(
    "/api/v1/tags",
    { name: "User Tag " + Date.now().toString(36), kind: "problem" },
    token,
  );
  if (status !== 403) throw new Error("期望 403, 实际 " + status);
  console.log("  ✓ 普通用户创建标签被拒");
});

e2eTest("[e2e/tags] 1.5 重复标签名冲突", async () => {
  if (!isE2E) return;
  const name = "E2E 重复 " + Date.now().toString(36);
  await apiPost("/api/v1/tags", { name, kind: "problem" }, adminToken);
  const { status } = await apiPost(
    "/api/v1/tags",
    { name, kind: "algorithm" },
    adminToken,
  );
  if (status !== 409) throw new Error("期望 409, 实际 " + status);
  console.log("  ✓ 重复标签名冲突检测正常");
});

e2eTest("[e2e/tags] 2.1 题目打标签并筛选命中", async () => {
  if (!isE2E) return;
  // 打标签：创建 U 型题目并带 tag_ids（admin 创建）
  const title = "E2E 标签题目 " + Date.now().toString(36);
  const res = await apiPost(
    "/api/v1/problems",
    {
      title,
      description: "标签筛选测试",
      difficulty: "easy",
      runtime_config: null,
      is_objective: true,
      tag_ids: [tagId],
    },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      "创建带标签题目失败: " + res.status + " " +
        JSON.stringify(res.body),
    );
  }
  problemId = (res.body as { data: { id: string } }).data.id;

  // 按标签筛选命中
  const listRes = await apiGet(
    `/api/v1/problems?tag=${tagId}&type=U`,
    adminToken,
  );
  if (listRes.status !== 200) throw new Error("筛选失败: " + listRes.status);
  const items = (listRes.body as { data: { id: string }[] }).data;
  if (!items.some((p) => p.id === problemId)) {
    throw new Error("按标签筛选未命中");
  }
  console.log("  ✓ 打标签 → ?tag= 筛选命中");
});

e2eTest("[e2e/tags] 2.2 标签与难度组合筛选", async () => {
  if (!isE2E) return;
  const res = await apiGet(
    `/api/v1/problems?tag=${tagId}&difficulty=easy&type=U`,
    adminToken,
  );
  if (res.status !== 200) throw new Error("组合筛选失败: " + res.status);
  const items = (res.body as { data: { id: string }[] }).data;
  if (!items.some((p) => p.id === problemId)) {
    throw new Error("组合筛选未命中");
  }
  console.log("  ✓ tag+difficulty 组合筛选");
});

e2eTest("[e2e/tags] 3.1 合并标签后关联正确", async () => {
  if (!isE2E) return;
  // 目标标签
  const targetName = "E2E 合并目标 " + Date.now().toString(36);
  const targetRes = await apiPost(
    "/api/v1/tags",
    { name: targetName, kind: "problem" },
    adminToken,
  );
  if (targetRes.status !== 201) throw new Error("创建目标标签失败");
  const targetId = (targetRes.body as { data: { id: string } }).data.id;

  const mergeRes = await apiPost(
    `/api/v1/tags/${tagId}/merge`,
    { target_id: targetId },
    adminToken,
  );
  if (mergeRes.status !== 204) {
    throw new Error("合并失败: " + mergeRes.status);
  }

  // 原标签已删除，关联重指向 target
  const listRes = await apiGet(
    `/api/v1/problems?tag=${targetId}&type=U`,
    adminToken,
  );
  const items = (listRes.body as { data: { id: string }[] }).data;
  if (!items.some((p) => p.id === problemId)) {
    throw new Error("合并后关联未重指向目标标签");
  }
  // 更新 tagId 引用为 target（后续删除测试用）
  tagId = targetId;
  console.log("  ✓ 合并标签后关联正确");
});

e2eTest("[e2e/tags] 3.2 删除标签后题目不受影响", async () => {
  if (!isE2E) return;
  const delRes = await apiDelete(`/api/v1/tags/${tagId}`, adminToken);
  if (delRes.status !== 204) throw new Error("删除标签失败: " + delRes.status);

  // 题目仍存在且不再关联该标签
  const detailRes = await apiGet(`/api/v1/problems/${problemId}`);
  if (detailRes.status !== 200) throw new Error("题目应仍存在");
  const d = detailRes.body as { data: { tags: { id: string }[] } };
  if (d.data.tags.some((t) => t.id === tagId)) {
    throw new Error("删除标签后题目仍有关联");
  }
  console.log("  ✓ 删除标签级联清理，题目不受影响");
});

e2eTest("[e2e/tags] 4.1 算法标签门控：匿名与未通过用户不可见", async () => {
  if (!isE2E) return;
  // 门控需要编程题（客观题禁止算法标签，打标会 400）：用经典 stdin/stdout
  // 样例题 P1001（A+B）使用标准 stdin/stdout 格式，适合作为 AC 判定载体。
  gatingProblemId = await getProblemIdByNumber(1001);
  if (!gatingProblemId) {
    console.log("  ⚠ 未找到 P1001，跳过门控隐藏场景");
    return;
  }

  // 给编程题打上算法标签（admin 更新）
  const putRes = await apiPut(
    `/api/v1/problems/${gatingProblemId}`,
    { tag_ids: [algorithmTagId] },
    adminToken,
  );
  if (putRes.status !== 200) {
    throw new Error("打算法标签失败: " + putRes.status);
  }

  // 匿名请求：has_hidden_algorithm_tags=true，tags 中无算法标签
  const anonRes = await apiGet(`/api/v1/problems/${gatingProblemId}`);
  const anonData = (anonRes.body as {
    data: {
      tags: { name: string; kind: string }[];
      has_hidden_algorithm_tags: boolean;
    };
  }).data;
  if (!anonData.has_hidden_algorithm_tags) {
    throw new Error("匿名用户应收到隐藏标志");
  }
  if (anonData.tags.some((t) => t.kind === "algorithm")) {
    throw new Error("匿名用户不应收到算法标签名");
  }

  // 未通过登录用户同样隐藏
  const { token } = await getOrCreateUser(
    "e2e_tag_viewer",
    "e2e_tag_viewer",
    "e2e_tag_viewer@e2e.local",
  );
  if (!token) throw new Error("获取用户失败");
  const viewerRes = await apiGet(`/api/v1/problems/${gatingProblemId}`, token);
  const viewerData = (viewerRes.body as {
    data: {
      tags: { kind: string }[];
      has_hidden_algorithm_tags: boolean;
    };
  }).data;
  if (!viewerData.has_hidden_algorithm_tags) {
    throw new Error("未通过用户应收到隐藏标志");
  }
  if (viewerData.tags.some((t) => t.kind === "algorithm")) {
    throw new Error("未通过用户不应收到算法标签名");
  }
  console.log("  ✓ 算法标签对匿名/未通过用户隐藏");
});

e2eTest("[e2e/tags] 4.2 算法标签门控：AC 后可见", async () => {
  if (!isE2E) return;
  if (!(await isJudgeAvailable())) {
    console.log("  ⚠ 评测不可用，跳过 AC 门控场景");
    return;
  }

  // 复用 4.1 获取的编程题；若 4.1 已跳过（无 P1001）则本场景同样跳过
  if (!gatingProblemId) {
    console.log("  ⚠ 无编程题（4.1 已跳过），跳过 AC 门控场景");
    return;
  }
  const judgeProblemId = gatingProblemId;
  const { token } = await getOrCreateUser(
    "e2e_tag_solver",
    "e2e_tag_solver",
    "e2e_tag_solver@e2e.local",
  );
  if (!token) throw new Error("获取用户失败");

  // 提交 A+B 解答并等待 AC（算法标签已在 4.1 打上）
  const submissionId = await submitCode(
    token,
    judgeProblemId,
    "a, b = map(int, input().split())\nprint(a + b)\n",
  );
  const result = await pollSubmission(token, submissionId, 45, 2000, true);
  if (result.status !== "finished" || result.score <= 0) {
    console.log(`  ⚠ 评测结果 ${result.status}，跳过 AC 可见性断言`);
    return;
  }

  const res = await apiGet(`/api/v1/problems/${judgeProblemId}`, token);
  const data = (res.body as {
    data: { tags: { kind: string }[]; has_hidden_algorithm_tags: boolean };
  }).data;
  if (data.has_hidden_algorithm_tags) {
    throw new Error("AC 用户不应收到隐藏标志");
  }
  if (!data.tags.some((t) => t.kind === "algorithm")) {
    throw new Error("AC 用户应看到算法标签");
  }
  console.log("  ✓ 算法标签 AC 后可见");
});

e2eTest("[e2e/tags] Cleanup", async () => {
  if (!isE2E) return;
  // 清理测试标签（题目保留无妨，客观题会被 dev 数据清理覆盖）
  for (const id of [tagId, algorithmTagId]) {
    if (id) await apiDelete(`/api/v1/tags/${id}`, adminToken);
  }
  console.log("  ✓ 测试标签已清理");
});
