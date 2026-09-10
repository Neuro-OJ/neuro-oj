/**
 * 评测任务三级优先级队列 E2E 测试。
 *
 * 覆盖：
 * - 进行中竞赛提交（high）能被消费；
 * - 普通提交（medium）能被消费；
 * - 管理员重测（low）能被消费；
 * - high 洪峰下 low 不被饿死（固定 4:2:1 轮转的最小回归断言）。
 */

import {
  apiPost,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

let adminToken = "";
let userToken = "";
let problemId = "";
let contestId = "";
let judgeOk = false;

e2eTest("[e2e/priority-queue] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  // 与 01/06/14 保持一致：judge 未就绪时快速跳过，而不是等满 poll 超时后硬失败。
  judgeOk = await isJudgeAvailable();
  if (!judgeOk) {
    console.log("  ⚠ judge worker 不可用，优先级队列测试跳过");
    return;
  }
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
  if (!isE2E || !judgeOk) return;

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

e2eTest("[e2e/priority-queue] high 洪峰下 low 仍能完成（不饿死）", async () => {
  if (!isE2E || !judgeOk) return;

  // 1) 先创建并**等到完成**一个普通提交，作为后续重测的合法目标。
  //
  // 顺序很重要：重测接口要求提交处于 finished/error 状态，否则 400
  // （见 noj-core submissions-rejudge.ts「仅已完成或出错的提交可以重测」）。
  // 因此必须**先**让该提交跑完，**再**制造洪峰并把它的重测任务排进队列；
  // 若像此前那样「先洪峰、后创建并立即重测」，提交仍在 pending/judging，
  // 重测必然 400。
  const lowRes = await apiPost(
    "/api/v1/submissions",
    {
      problem_id: problemId,
      language: "python3",
      code: CODE_SAMPLES.accepted,
    },
    userToken,
  );
  if (lowRes.status !== 201) {
    throw new Error(`普通提交失败: ${lowRes.status}`);
  }
  const lowId = (lowRes.body as { data: { id: string } }).data.id;
  await pollSubmission(adminToken, lowId, 60, 2000, true);

  // 2) 压入一批 high（进行中竞赛提交），制造高优先级洪峰
  const highIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await apiPost(
      "/api/v1/submissions",
      {
        problem_id: problemId,
        language: "python3",
        code: CODE_SAMPLES.accepted,
        contest_id: contestId,
      },
      userToken,
    );
    if (res.status !== 201) {
      throw new Error(`竞赛提交失败: ${res.status}`);
    }
    highIds.push((res.body as { data: { id: string } }).data.id);
  }

  // 3) 把已完成的提交重测 → 在洪峰仍在队列中时排入一个 low 任务
  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${lowId}/rejudge`,
    {},
    adminToken,
  );
  if (rejudge.status !== 200) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }

  // 4) low 必须在有界时间内完成：4:2:1 轮转保证每 7 次取任务至少取 1 次 low。
  //    若轮转退化为「高优先级不空就永远不取 low」，这里会超时失败。
  await pollSubmission(adminToken, lowId, 90, 2000, true);
  console.log(`  ✓ high 洪峰(${highIds.length})下 low 任务已完成`);
});
