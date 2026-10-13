/**
 * 评测任务三级优先级队列 E2E 测试。
 *
 * 覆盖：
 * - 进行中竞赛提交（high）能被消费；
 * - 普通提交（medium）能被消费；
 * - 管理员重测（low）能被消费；
 * - high 洪峰下 low 不被饿死（固定 4:2:1 轮转的最小回归断言）。
 *
 * 使用独立题目；medium 在建赛之前受理，high 通过正式比赛入口受理。
 * low 等待重测任务终态，不以原提交已完成的状态证明新的尝试执行。
 */

import {
  apiPost,
  CODE_SAMPLES,
  e2eTest,
  getAdminToken,
  getContestAnswerVersionId,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForJobCompleted,
  waitForServer,
} from "../helper.ts";
import { createCodingProblemFixture } from "../fixtures/coding-problem.ts";

let adminToken = "";
let userToken = "";
let problemId = "";
let contestId = "";

/** 邀请赛邀请码（`kind='invite'` 必须设置，报名时校验）。 */
const CONTEST_PASSWORD = "PqInvitePass1";

/**
 * 建一场进行中的**邀请赛**并把题目挂进去，同时让 userToken 报名参赛。
 *
 * 邀请赛验证实际报名与密码；题目独立，不让比赛保密窗口影响其他回归。
 *
 * @returns 竞赛 id（high 提交与报名身份都需要）。
 */
async function createRunningContestWithRegistration(): Promise<string> {
  const ts = Date.now().toString(36);
  const now = Date.now();
  const contest = await apiPost(
    "/api/v1/admin/contest/contests",
    {
      title: `pq-${ts}`,
      start_time: new Date(now - 60_000).toISOString(),
      end_time: new Date(now + 3_600_000).toISOString(),
      type: "kaggle",
      config: {},
      is_public: false,
      kind: "invite",
      password: CONTEST_PASSWORD,
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
  const id = (contest.body as { data: { id: string } }).data.id;

  // 竞赛提交要求参赛者身份（verifyContestAccess 校验成员 + 窗口）
  const reg = await apiPost(
    `/api/v1/contests/${id}/register`,
    { password: CONTEST_PASSWORD },
    userToken,
  );
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`报名失败: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  return id;
}

/** 竞赛入口提交（服务端据此推导为 high 优先级）。 */
async function submitInContest(code = CODE_SAMPLES.accepted): Promise<string> {
  const versionId = await getContestAnswerVersionId(
    userToken,
    contestId,
    problemId,
  );
  const res = await apiPost(
    `/api/v1/contests/${contestId}/submit`,
    { problem_id: problemId, language: "python3", code, version_id: versionId },
    userToken,
  );
  if (res.status !== 201) {
    throw new Error(
      `竞赛提交失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

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
  problemId = await createCodingProblemFixture();

  // 竞赛在用例 1 里、medium 提交之后才创建：题目一旦进竞赛，独立入口即对该题 403。
});

e2eTest("[e2e/priority-queue] high/medium/low 均能被消费", async () => {
  if (!isE2E) return;

  // medium：普通提交（此时题目尚未加入任何竞赛）
  const mediumId = await submitCode(
    userToken,
    problemId,
    CODE_SAMPLES.accepted,
  );

  // high：进行中竞赛提交（建赛 + 报名 + 竞赛入口提交）
  contestId = await createRunningContestWithRegistration();
  const highId = await submitInContest();

  await pollSubmission(adminToken, highId, 60, 2000, true);
  await pollSubmission(adminToken, mediumId, 60, 2000, true);

  // low：管理员重测普通提交
  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${mediumId}/rejudge`,
    {},
    adminToken,
  );
  // 统一任务受理后单条重测返回 202 + 任务 ID（Handbook §4.3）
  if (rejudge.status !== 202) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }
  const job = await waitForJobCompleted(
    adminToken,
    (rejudge.body as { data: { job_id: string } }).data.job_id,
  );
  if (job.status !== "completed") {
    throw new Error(`重测任务失败: ${job.status}`);
  }
  await pollSubmission(adminToken, mediumId, 60, 2000, true);
});

e2eTest("[e2e/priority-queue] high 洪峰下 low 仍能完成（不饿死）", async () => {
  if (!isE2E) return;
  if (!contestId) {
    throw new Error("竞赛未创建（用例 1 未成功执行）");
  }

  // 1) 先创建并**等到完成**一个提交，作为后续重测的合法目标。
  //
  // 顺序很重要：重测接口要求提交处于 finished/error 状态，否则 400
  // （见 noj-core submissions-rejudge.ts「仅已完成或出错的提交可以重测」）。
  // 因此必须**先**让该提交跑完，**再**制造洪峰并把它的重测任务排进队列；
  // 若像此前那样「先洪峰、后创建并立即重测」，提交仍在 pending/judging，
  // 重测必然 400。
  const baseId = await submitInContest();
  await pollSubmission(adminToken, baseId, 60, 2000, true);

  // 2) 压入一批 high（进行中竞赛提交），制造高优先级洪峰
  const highIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    highIds.push(await submitInContest());
  }

  // 3) 把已完成的提交重测 → 在洪峰仍在队列中时排入一个 low 任务
  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${baseId}/rejudge`,
    {},
    adminToken,
  );
  // 统一任务受理后单条重测返回 202 + 任务 ID（Handbook §4.3）
  if (rejudge.status !== 202) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }

  // 4) low 必须在有界时间内完成：4:2:1 轮转保证每 7 次取任务至少取 1 次 low。
  //    若轮转退化为「高优先级不空就永远不取 low」，这里会超时失败。
  const job = await waitForJobCompleted(
    adminToken,
    (rejudge.body as { data: { job_id: string } }).data.job_id,
    90,
    2000,
  );
  if (job.status !== "completed") {
    throw new Error(`重测任务失败: ${job.status}`);
  }
  await pollSubmission(adminToken, baseId, 90, 2000, true);
  console.log(`  ✓ high 洪峰(${highIds.length})下 low 任务已完成`);
});
