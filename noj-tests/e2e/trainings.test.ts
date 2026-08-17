import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
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
    user.token,
  );
  if (problemRes.status !== 201) {
    throw new Error(`建题失败: ${JSON.stringify(problemRes.body)}`);
  }
  const problemId = (problemRes.body as { data: { id: string } }).data.id;

  const created = await apiPost(
    "/api/v1/trainings",
    { title: "E2E 题单", visibility: "private" },
    user.token,
  );
  if (created.status !== 201) {
    throw new Error(`建题单失败: ${JSON.stringify(created.body)}`);
  }
  const trainingId = (created.body as { data: { id: string } }).data.id;

  const added = await apiPost(
    `/api/v1/trainings/${trainingId}/problems`,
    { problem_id: problemId },
    user.token,
  );
  if (added.status !== 201) {
    throw new Error(`加题失败: ${JSON.stringify(added.body)}`);
  }

  const hidden = await apiGet(`/api/v1/trainings/${trainingId}`, other.token);
  if (hidden.status !== 404) {
    throw new Error(`私有题单应对他人 404: ${hidden.status}`);
  }

  const subId = await submitCode(user.token, problemId, "print(1)");
  await pollSubmission(user.token, subId);
  const problems = await apiGet(
    `/api/v1/trainings/${trainingId}/problems`,
    user.token,
  );
  if (problems.status !== 200) {
    throw new Error(`取题单题目失败: ${problems.status}`);
  }
  const problemsData = (problems.body as { data: { accepted: boolean }[] }).data;
  if (!problemsData[0]?.accepted) {
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

  const deleted = await apiDelete(`/api/v1/problems/${problemId}`, user.token);
  if (deleted.status !== 204 && deleted.status !== 200) {
    throw new Error(`删题失败: ${deleted.status}`);
  }
  const afterDelete = await apiGet(
    `/api/v1/trainings/${trainingId}/problems`,
    user.token,
  );
  const afterData = (afterDelete.body as { data: unknown[] }).data;
  if (afterData.length !== 0) {
    throw new Error("删除题目后题单关联应自动清理");
  }
});
