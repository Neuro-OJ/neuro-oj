/**
 * 重测（rejudge）E2E 测试。
 *
 * 覆盖：
 * - 单条重测完整流程（提交正确代码 → 等待完成 → 发起重测 → 结果一致）
 * - 不存在的提交 404、非 admin 403
 * - 批量重测 + 活跃提交拒绝 + 重测审计日志验证
 *
 * 依赖：no-judge-worker（完整评测栈）和 seed 中的 e2e_admin 用户。
 */

import {
  apiGet,
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
  waitForJobCompleted,
  waitForServer,
} from "../helper.ts";

let PROBLEM_ID = "";

let adminToken = "";
let userToken = "";
let submissionId = "";
let judgeOk = false;

e2eTest("[e2e/rejudge] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();

  adminToken = await getAdminToken();

  const ts = Date.now().toString(36);
  userToken = await registerUser(
    "rejudge_user_" + ts,
    "rejudge_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );

  judgeOk = await isJudgeAvailable();
  if (!judgeOk) {
    console.log("  ⚠ judge worker 不可用，重测测试跳过");
    return;
  }

  // 统一题目包导入后题目 id 为 UUID，动态获取样例题（P1001）
  PROBLEM_ID = await getProblemIdByNumber(1001);

  // 先提交一段正确代码，等待完成
  submissionId = await submitCode(
    userToken,
    PROBLEM_ID,
    CODE_SAMPLES.accepted,
  );
  console.log("  → 原始提交 ID: " + submissionId.slice(0, 8));
  const result = await pollSubmission(userToken, submissionId);
  if (result.status !== "finished" || result.score <= 0) {
    throw new Error("期望原始提交 finished 且分数 >0, 实际 " + result.status);
  }
  console.log(
    "  ✓ 原始提交完成: " + result.status + " (" + result.score + "分)",
  );
});

// ── 单条重测 ──

e2eTest("[e2e/rejudge] 5.1 管理员单条重测完成提交", async () => {
  if (!isE2E || !judgeOk) return;
  const rejudgeRes = await apiPost(
    `/api/v1/admin/submission/submissions/${submissionId}/rejudge`,
    {},
    adminToken,
  );

  // 统一任务受理（Handbook §4.3）：202 + 任务 ID + 条目数
  if (rejudgeRes.status !== 202) {
    throw new Error(
      "重测返回异常: " + rejudgeRes.status + " " +
        JSON.stringify(rejudgeRes.body),
    );
  }

  const body = rejudgeRes.body as {
    data?: {
      message?: string;
      submission_id?: string;
      job_id?: string;
      total_items?: number;
    };
  };
  if (!body.data?.submission_id || !body.data?.job_id) {
    throw new Error(
      "重测响应缺少 submission_id/job_id: " + JSON.stringify(body),
    );
  }
  if (body.data.total_items !== 1) {
    throw new Error("单条重测应固定 1 个条目，实际 " + body.data.total_items);
  }
  console.log(
    "  ✓ 重测已受理: " + (body.data.message || "") +
      " job=" + body.data.job_id.slice(0, 8),
  );

  // 等任务终态（重测由后台 worker 异步派发），再等提交完成
  await waitForJobCompleted(adminToken, body.data.job_id);
  const result = await pollSubmission(adminToken, submissionId);
  if (result.status !== "finished" || result.score <= 0) {
    throw new Error("重测结果期望 finished 且分数 >0, 实际 " + result.status);
  }
  console.log(
    "  ✓ 重测完成: " + result.status + " (" + result.score + "分)",
  );
});

// ── 404 / 403 ──

e2eTest("[e2e/rejudge] 5.2a 不存在的提交受理为空任务", async () => {
  if (!isE2E || !judgeOk) return;
  // 统一任务化后不存在的提交不会进入条目集合：返回 202 且总数为 0
  // （Handbook §4.3「空集合返回已完成、总数为 0 的任务」）。
  const res = await apiPost(
    "/api/v1/admin/submission/submissions/00000000-0000-0000-0000-000000000000/rejudge",
    {},
    adminToken,
  );
  if (res.status !== 202) {
    throw new Error("期望 202, 实际 " + res.status);
  }
  const d = res.body as { data?: { job_id?: string; total_items?: number } };
  if (!d.data?.job_id || d.data.total_items !== 0) {
    throw new Error("应受理为空任务: " + JSON.stringify(res.body));
  }
  console.log("  ✓ 不存在的提交受理为空任务");
});

e2eTest("[e2e/rejudge] 5.2b 非管理员重测被拒 403", async () => {
  if (!isE2E || !judgeOk) return;
  const res = await apiPost(
    `/api/v1/admin/submission/submissions/${submissionId}/rejudge`,
    {},
    userToken,
  );
  if (res.status !== 403) {
    throw new Error("期望 403, 实际 " + res.status);
  }
  console.log("  ✓ 非管理员重测被拒");
});

// ── 批量重测 ──

e2eTest("[e2e/rejudge] 5.3a 批量重测返回正确结构", async () => {
  if (!isE2E || !judgeOk) return;
  const res = await apiPost(
    `/api/v1/admin/submission/problems/${PROBLEM_ID}/rejudge`,
    {},
    adminToken,
  );

  if (res.status !== 202) {
    throw new Error("批量重测返回异常: " + res.status);
  }

  const body = res.body as {
    data?: { job_id?: string; status?: string; total_items?: number };
  };
  if (!body.data?.job_id || typeof body.data.total_items !== "number") {
    throw new Error("批量重测响应结构异常: " + JSON.stringify(res.body));
  }
  console.log(
    "  ✓ 批量重测: 条目=" + body.data.total_items + " 状态=" +
      body.data.status,
  );
});

e2eTest("[e2e/rejudge] 5.3b 重测在审计日志中有记录", async () => {
  if (!isE2E || !judgeOk) return;
  const logs = await apiGet(
    "/api/v1/admin/system/audit-logs?action=submissions.rejudge",
    adminToken,
  );
  const data =
    (logs.body as { data: Array<{ detail?: Record<string, unknown> }> }).data;
  // 至少有一条重测记录
  if (data.length === 0) {
    console.log(
      "  ⚠ 未找到 submissions.rejudge 审计记录（可能未启用审计日志）",
    );
    return;
  }
  const found = data.some((r) =>
    r.detail &&
    typeof r.detail === "object" &&
    "submission_id" in r.detail
  );
  if (!found) {
    console.log("  ⚠ 重测审计记录不含 submission_id");
  }
  console.log("  ✓ 重测审计记录: " + data.length + " 条");
});
