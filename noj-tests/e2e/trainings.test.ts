import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
  getProblemIdByNumber,
  pollSubmission,
  submitCode,
} from "./helper.ts";

e2eTest("training e2e: 建题单→加题→进度→可见性→删题清理", async () => {
  const adminToken = await getAdminToken();
  const user = await getOrCreateUser(
    "training_user",
    `training_user_${Date.now().toString(36)}`,
    `training_user_${Date.now().toString(36)}@test.com`,
  );
  const other = await getOrCreateUser(
    "training_other",
    `training_other_${Date.now().toString(36)}`,
    `training_other_${Date.now().toString(36)}@test.com`,
  );

  // 用 admin 创建 U 型题（普通用户设置 evaluator.command 已被 RBAC 拒绝）
  const problemRes = await apiPost(
    "/api/v1/problems",
    {
      title: "Training E2E Problem",
      description: "e2e",
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
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
    },
    adminToken,
  );
  if (problemRes.status !== 201) {
    throw new Error(`建题失败: ${JSON.stringify(problemRes.body)}`);
  }
  const problemId = (problemRes.body as { data: { id: string } }).data.id;
  const sampleProblemId = await getProblemIdByNumber(1003);

  const created = await apiPost(
    "/api/v1/trainings",
    { title: "E2E 题单", visibility: "private" },
    user.token,
  );
  if (created.status !== 201) {
    throw new Error(`建题单失败: ${JSON.stringify(created.body)}`);
  }
  const trainingId = (created.body as { data: { id: string } }).data.id;

  for (const pid of [problemId, sampleProblemId]) {
    const added = await apiPost(
      `/api/v1/trainings/${trainingId}/problems`,
      { problem_id: pid },
      user.token,
    );
    if (added.status !== 201) {
      throw new Error(`加题失败: ${JSON.stringify(added.body)}`);
    }
  }

  const hidden = await apiGet(`/api/v1/trainings/${trainingId}`, other.token);
  if (hidden.status !== 404) {
    throw new Error(`私有题单应对他人 404: ${hidden.status}`);
  }

  // 用样例题 P1003（A+B）验证 AC 进度聚合
  const subId = await submitCode(
    user.token,
    sampleProblemId,
    `from noj_solution_sdk import register

@register
def solve(text: str) -> str:
    a, b = map(int, text.strip().split())
    return str(a + b)
`,
  );
  await pollSubmission(user.token, subId);
  const problems = await apiGet(
    `/api/v1/trainings/${trainingId}/problems`,
    user.token,
  );
  if (problems.status !== 200) {
    throw new Error(`取题单题目失败: ${problems.status}`);
  }
  const problemsData = (problems.body as {
    data: Array<{ problem_id: string; accepted: boolean }>;
  }).data;
  const sample = problemsData.find((p) => p.problem_id === sampleProblemId);
  if (!sample?.accepted) {
    throw new Error("AC 后进度应为 true");
  }

  const patched = await apiPatch(
    `/api/v1/admin/trainings/${trainingId}`,
    { visibility: "public", is_pinned: true },
    adminToken,
  );
  if (patched.status !== 200) {
    throw new Error(`管理员设 public 失败: ${patched.status}`);
  }

  const list = await apiGet("/api/v1/trainings");
  const listData = (list.body as { data: { id: string }[] }).data;
  if (!listData.some((t) => t.id === trainingId)) {
    throw new Error("公开列表应包含该题单");
  }

  const deleted = await apiDelete(`/api/v1/problems/${problemId}`, adminToken);
  if (deleted.status !== 204 && deleted.status !== 200) {
    throw new Error(`删题失败: ${deleted.status}`);
  }
  const afterDelete = await apiGet(
    `/api/v1/trainings/${trainingId}/problems`,
    user.token,
  );
  const afterData = (afterDelete.body as {
    data: Array<{ problem_id: string }>;
  }).data;
  if (afterData.some((p) => p.problem_id === problemId)) {
    throw new Error("删除题目后题单关联应自动清理");
  }
});
