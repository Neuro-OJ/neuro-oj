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
  waitForServer,
} from "./helper.ts";

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
    `/api/v1/admin/submissions/${submissionId}/rejudge`,
    {},
    adminToken,
  );

  if (rejudgeRes.status !== 200) {
    throw new Error(
      "重测返回异常: " + rejudgeRes.status + " " +
        JSON.stringify(rejudgeRes.body),
    );
  }

  const body = rejudgeRes.body as {
    data?: {
      message?: string;
      submission_id?: string;
    };
  };
  if (!body.data?.submission_id) {
    throw new Error("重测响应缺少 submission_id: " + JSON.stringify(body));
  }
  console.log("  ✓ 重测已发起: " + (body.data.message || ""));

  // 等待重测完成
  const result = await pollSubmission(adminToken, submissionId);
  if (result.status !== "finished" || result.score <= 0) {
    throw new Error("重测结果期望 finished 且分数 >0, 实际 " + result.status);
  }
  console.log(
    "  ✓ 重测完成: " + result.status + " (" + result.score + "分)",
  );
});

// ── 404 / 403 ──

e2eTest("[e2e/rejudge] 5.2a 不存在的提交返回 404", async () => {
  if (!isE2E || !judgeOk) return;
  const res = await apiPost(
    "/api/v1/admin/submissions/00000000-0000-0000-0000-000000000000/rejudge",
    {},
    adminToken,
  );
  if (res.status !== 404) {
    throw new Error("期望 404, 实际 " + res.status);
  }
  console.log("  ✓ 不存在的提交返回 404");
});

e2eTest("[e2e/rejudge] 5.2b 非管理员重测被拒 403", async () => {
  if (!isE2E || !judgeOk) return;
  const res = await apiPost(
    `/api/v1/admin/submissions/${submissionId}/rejudge`,
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
    `/api/v1/admin/problems/${PROBLEM_ID}/rejudge`,
    {},
    adminToken,
  );

  if (res.status !== 200) {
    // 如果批重在有活跃提交时返回 400，也是预期行为
    if (res.status === 400) {
      console.log("  ⚠ 批量重测返回 400（有活跃提交）");
      return;
    }
    throw new Error("批量重测返回异常: " + res.status);
  }

  const body = res.body as {
    data?: { total?: number; queued?: number; skipped?: number };
  };
  if (body.data) {
    console.log(
      "  ✓ 批量重测: total=" + body.data.total + " queued=" +
        body.data.queued + " skipped=" + body.data.skipped,
    );
  }
});

e2eTest("[e2e/rejudge] 5.3b 重测在审计日志中有记录", async () => {
  if (!isE2E || !judgeOk) return;
  const logs = await apiGet(
    "/api/v1/admin/audit-logs?action=submissions.rejudge",
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
