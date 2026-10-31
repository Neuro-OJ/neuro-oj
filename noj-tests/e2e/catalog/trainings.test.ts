import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
  getProblemIdByNumber,
  pollSubmission,
  publishProblemVersion,
  submitCode,
} from "../helper.ts";

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
  const identity = await apiGet("/api/v1/auth/me", user.token);
  const userId = (identity.body as { data: { id: string } }).data.id;
  const granted = await apiPut(`/api/v1/domains/main/members/${userId}/roles`, {
    roles: ["editor"],
  }, adminToken);
  if (granted.status !== 200) {
    throw new Error(`授予域资源编辑角色失败: ${JSON.stringify(granted.body)}`);
  }

  // 管理员创建默认域题目，普通成员不得设置敏感评测字段。
  const problemRes = await apiPost(
    "/api/v1/problems",
    {
      title: "Training E2E Problem",
      description: "e2e",
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
  const publicRes = await apiPut(
    `/api/v1/problems/${problemId}/visibility`,
    { visibility: "public" },
    adminToken,
  );
  if (publicRes.status !== 200) {
    throw new Error(
      `管理员设题目 public 失败: ${JSON.stringify(publicRes.body)}`,
    );
  }
  await publishProblemVersion(adminToken, problemId, "题单源题发布");
  const sampleProblemId = await getProblemIdByNumber(1001);

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

  // 用样例题 P1001（A+B）验证 AC 进度聚合
  const subId = await submitCode(
    user.token,
    sampleProblemId,
    CODE_SAMPLES.accepted,
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
    `/api/v1/admin/catalog/trainings/${trainingId}`,
    { state: "published", is_pinned: true },
    adminToken,
  );
  if (patched.status !== 200) {
    throw new Error(`管理员设 published 失败: ${patched.status}`);
  }

  const list = await apiGet("/api/v1/trainings");
  const listData = (list.body as { data: { id: string }[] }).data;
  if (!listData.some((t) => t.id === trainingId)) {
    throw new Error("公开列表应包含该题单");
  }

  const deleted = await apiDelete(`/api/v1/problems/${problemId}`, adminToken);
  if (deleted.status !== 409) {
    throw new Error(`已发布源题不得物理删除: ${deleted.status}`);
  }
  const withdrawn = await apiPut(`/api/v1/problems/${problemId}/visibility`, {
    visibility: "private",
  }, adminToken);
  if (withdrawn.status !== 200) throw new Error("更新源题可见性失败");
  const afterDelete = await apiGet(
    `/api/v1/trainings/${trainingId}/problems`,
  );
  const afterData = (afterDelete.body as {
    data: Array<{ problem_id: string }>;
  }).data;
  if (!afterData.some((p) => p.problem_id === problemId)) {
    throw new Error("公开域已发布源题在题单中应保持可见");
  }
});
