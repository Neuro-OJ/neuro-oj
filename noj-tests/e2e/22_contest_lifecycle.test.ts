/**
 * 竞赛完整生命周期 E2E 测试。
 *
 * 覆盖管理员创建竞赛、用户注册、竞赛提交、封榜期间排名、
 * 竞赛结束后的自动解封。
 */

import {
  apiGet,
  apiPost,
  apiPut,
  CODE_SAMPLES,
  getAdminToken,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const testSuffix = Date.now().toString(36);
let adminToken = "";
let participantToken = "";
let contestId = "";
let judgeAvailable = false;

interface ContestData {
  id: string;
  status: string;
}

interface IcpcRankingRow {
  solved: number;
}

Deno.test({
  name: "[e2e/contest] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
    participantToken = await registerUser(
      `contest_user_${testSuffix}`,
      `contest_user_${testSuffix}@test.com`,
      "Test12345679",
    );
    judgeAvailable = await isJudgeAvailable();
    if (!judgeAvailable) {
      console.log("  ⚠ judge worker 不可用，提交与排名断言将跳过");
    }
  },
});

Deno.test({
  name: "[e2e/contest] 1. 创建正在进行且已封榜的 ICPC 竞赛",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const now = Date.now();
    const createResult = await apiPost(
      "/api/v1/admin/contests",
      {
        title: `E2E 生命周期竞赛 ${testSuffix}`,
        start_time: new Date(now - 60 * 60 * 1000).toISOString(),
        end_time: new Date(now + 60 * 60 * 1000).toISOString(),
        type: "icpc",
        config: {
          penalty_minutes: 20,
          freeze_time: new Date(now - 60 * 1000).toISOString(),
          unfreeze_after_end: true,
        },
        is_public: true,
        password: "ContestPass123",
        affect_global_ranking: false,
        problems: [{ problem_id: "1001", sort_order: 0, label: "A" }],
      },
      adminToken,
    );
    if (createResult.status !== 201) {
      throw new Error(
        `创建竞赛失败: ${createResult.status} ${
          JSON.stringify(createResult.body)
        }`,
      );
    }
    contestId = (createResult.body as { data: ContestData }).data.id;
    if (!contestId) throw new Error("创建竞赛响应缺少 id");
  },
});

Deno.test({
  name: "[e2e/contest] 2. 用户注册并进行竞赛提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const invalidPassword = await apiPost(
      `/api/v1/contests/${contestId}/register`,
      { password: "wrong-password" },
      participantToken,
    );
    if (invalidPassword.status !== 403) {
      throw new Error(
        `错误密码应被拒绝，实际状态码: ${invalidPassword.status}`,
      );
    }

    const registerResult = await apiPost(
      `/api/v1/contests/${contestId}/register`,
      { password: "ContestPass123" },
      participantToken,
    );
    if (registerResult.status !== 201) {
      throw new Error(
        `注册竞赛失败: ${registerResult.status} ${
          JSON.stringify(registerResult.body)
        }`,
      );
    }
    if (!judgeAvailable) return;

    const submitResult = await apiPost(
      `/api/v1/contests/${contestId}/submit`,
      { problem_id: "1001", language: "python3", code: CODE_SAMPLES.accepted },
      participantToken,
    );
    if (submitResult.status !== 201) {
      throw new Error(
        `竞赛提交失败: ${submitResult.status} ${
          JSON.stringify(submitResult.body)
        }`,
      );
    }
    const submissionId =
      (submitResult.body as { data: { id: string } }).data.id;
    const result = await pollSubmission(participantToken, submissionId);
    if (result.verdict !== "Accepted") {
      throw new Error(`期望 Accepted，实际 ${result.verdict}`);
    }
  },
});

Deno.test({
  name: "[e2e/contest] 3. 封榜时公开排名冻结而管理员可见完整排名",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeAvailable) return;
    const [publicResult, adminResult] = await Promise.all([
      apiGet(`/api/v1/contests/${contestId}/ranking`),
      apiGet(`/api/v1/contests/${contestId}/ranking`, adminToken),
    ]);
    if (publicResult.status !== 200 || adminResult.status !== 200) {
      throw new Error(
        `读取封榜排名失败: ${publicResult.status}/${adminResult.status}`,
      );
    }
    const publicRows = (publicResult.body as { data: IcpcRankingRow[] }).data;
    const adminRows = (adminResult.body as { data: IcpcRankingRow[] }).data;
    if (publicRows[0]?.solved !== 0) {
      throw new Error("封榜期间公开排名不应包含封榜后的 AC");
    }
    if (adminRows[0]?.solved !== 1) {
      throw new Error("管理员在封榜期间应看到完整排名");
    }
  },
});

Deno.test({
  name: "[e2e/contest] 4. 结束竞赛后自动解封并公开最终排名",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeAvailable) return;
    const updateResult = await apiPut(
      `/api/v1/admin/contests/${contestId}`,
      { end_time: new Date(Date.now() - 1000).toISOString() },
      adminToken,
    );
    if (updateResult.status !== 200) {
      throw new Error(
        `结束竞赛失败: ${updateResult.status} ${
          JSON.stringify(updateResult.body)
        }`,
      );
    }

    const [contestResult, rankingResult] = await Promise.all([
      apiGet(`/api/v1/contests/${contestId}`),
      apiGet(`/api/v1/contests/${contestId}/ranking`),
    ]);
    const contest = (contestResult.body as { data: ContestData }).data;
    const rows = (rankingResult.body as { data: IcpcRankingRow[] }).data;
    if (contestResult.status !== 200 || contest.status !== "ended") {
      throw new Error("竞赛结束后状态应为 ended");
    }
    if (rankingResult.status !== 200 || rows[0]?.solved !== 1) {
      throw new Error("竞赛结束后公开排名应自动解封并显示最终 AC");
    }
  },
});
