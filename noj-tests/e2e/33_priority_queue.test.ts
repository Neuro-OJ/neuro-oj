/**
 * 评测任务三级优先级队列 E2E 测试。
 *
 * 覆盖：
 * - 进行中竞赛提交（high）能被消费；
 * - 普通提交（medium）能被消费；
 * - 管理员重测（low）能被消费。
 */

import {
  apiPost,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

let adminToken = "";
let userToken = "";
let problemId = "";
let contestId = "";

e2eTest("[e2e/priority-queue] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  userToken = await registerUser(
    `pq_${ts}`,
    `pq_${ts}@test.com`,
    TEST_PASSWORD,
  );
  problemId = await getProblemIdByNumber(1001);

  const now = Date.now();
  const contest = await apiPost(
    "/api/v1/admin/contest/contests",
    {
      title: `pq-${ts}`,
      start_time: new Date(now - 60_000).toISOString(),
      end_time: new Date(now + 3_600_000).toISOString(),
      type: "kaggle",
      config: {},
      is_public: true,
      kind: "public",
      affect_global_ranking: false,
      problems: [{
        problem_id: problemId,
        sort_order: 0,
        label: "A",
        score: 100,
      }],
    },
    adminToken,
  );
  if (contest.status !== 201) {
    throw new Error(
      `创建竞赛失败: ${contest.status} ${JSON.stringify(contest.body)}`,
    );
  }
  contestId = (contest.body as { data: { id: string } }).data.id;
});

e2eTest("[e2e/priority-queue] high/medium/low 均能被消费", async () => {
  if (!isE2E) return;

  // high：进行中竞赛提交
  const highRes = await apiPost(
    "/api/v1/submissions",
    {
      problem_id: problemId,
      language: "python3",
      code: CODE_SAMPLES.accepted,
      contest_id: contestId,
    },
    userToken,
  );
  if (highRes.status !== 201) {
    throw new Error(
      `竞赛提交失败: ${highRes.status} ${JSON.stringify(highRes.body)}`,
    );
  }
  const highId = (highRes.body as { data: { id: string } }).data.id;

  // medium：普通提交
  const mediumId = await submitCode(
    userToken,
    problemId,
    CODE_SAMPLES.accepted,
  );

  await pollSubmission(adminToken, highId, 60, 2000, true);
  await pollSubmission(adminToken, mediumId, 60, 2000, true);

  // low：管理员重测普通提交
  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${mediumId}/rejudge`,
    {},
    adminToken,
  );
  if (rejudge.status !== 200) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }
  await pollSubmission(adminToken, mediumId, 60, 2000, true);
});
