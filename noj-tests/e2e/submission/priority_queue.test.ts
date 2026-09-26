/**
 * 评测任务三级优先级队列 E2E 测试。
 *
 * 覆盖：
 * - 进行中竞赛提交（high）能被消费；
 * - 普通提交（medium）能被消费；
 * - 管理员重测（low）能被消费；
 * - high 洪峰下 low 不被饿死（固定 4:2:1 轮转的最小回归断言）。
 *
 * 2026-09-26 调整（公开赛题目保密规则）：
 * - 评测优先级由**提交携带的竞赛上下文**推导（`resolveJudgeTaskPriority`），而
 *   独立入口 `POST /api/v1/submissions` 从不接受竞赛上下文（`body.contest_id`
 *   会被路由丢弃）——因此 high 必须走 `POST /api/v1/contests/:id/submit`；
 * - 题目一旦被加入公开赛，独立入口对该题对非 owner/管理员一律 403
 *   （`resolveProblemAccess` 的 `contest-secret` 判定），所以 medium 提交必须在
 *   "题目加入竞赛之前"发出，而重测目标改用竞赛入口创建（重测任务优先级恒为 low，
 *   与初次提交优先级无关）；
 * - 本用例的竞赛改用**邀请赛**：见 `createRunningContestWithRegistration` 的说明
 *   （公开赛会让共享题 P1001 在整轮 e2e 剩余时间里对独立入口不可用，污染同域后续用例）。
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

/** 邀请赛邀请码（`kind='invite'` 必须设置，报名时校验）。 */
const CONTEST_PASSWORD = "PqInvitePass1";

/**
 * 建一场进行中的**邀请赛**并把题目挂进去，同时让 userToken 报名参赛。
 *
 * 为什么用邀请赛而不是公开赛（2026-09-26 CI 实测）：
 * 本次改动引入了"被公开赛关联的题目对非 owner/管理员一律 404/403"的保密规则。
 * 本用例只需要"题目处于进行中竞赛 ⇒ 提交推导为 high"，与竞赛是否公开无关；
 * 但若用公开赛，共享题 P1001 会在整轮 e2e 的剩余时间里变成"公开赛关联题目"，
 * 同域后续用例（`[e2e/queue] 7.2/7.3` 等）经独立入口 `POST /api/v1/submissions`
 * 提交该题会被 403 —— 这就是 CI 上实际观测到的失败。
 * 邀请赛不触发保密规则（规则显式排除 `kind='invite'`），因此天然隔离：
 * 既不需要收尾清理，也不依赖测试文件执行顺序。
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
  const res = await apiPost(
    `/api/v1/contests/${contestId}/submit`,
    { problem_id: problemId, language: "python3", code },
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

  // 竞赛在用例 1 里、medium 提交之后才创建：题目一旦进竞赛，独立入口即对该题 403。
});

e2eTest("[e2e/priority-queue] high/medium/low 均能被消费", async () => {
  if (!isE2E || !judgeOk) return;

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
  if (rejudge.status !== 200) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }
  await pollSubmission(adminToken, mediumId, 60, 2000, true);
});

e2eTest("[e2e/priority-queue] high 洪峰下 low 仍能完成（不饿死）", async () => {
  if (!isE2E || !judgeOk) return;
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
  if (rejudge.status !== 200) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }

  // 4) low 必须在有界时间内完成：4:2:1 轮转保证每 7 次取任务至少取 1 次 low。
  //    若轮转退化为「高优先级不空就永远不取 low」，这里会超时失败。
  await pollSubmission(adminToken, baseId, 90, 2000, true);
  console.log(`  ✓ high 洪峰(${highIds.length})下 low 任务已完成`);
});
