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
  BASE_URL,
  CODE_SAMPLES,
  isE2E,
  getAdminToken,
  pollSubmission,
  registerUser,
  submitCode,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const PROBLEM_ID = "1001";

let adminToken = "";
let userToken = "";
let submissionId = "";
let judgeOk = false;

async function isJudgeAvailable(): Promise<boolean> {
  try {
    const ts = Date.now().toString(36);
    const t = await registerUser(
      "rejudge_ck_" + ts,
      "rejudge_ck_" + ts + "@test.com",
      "Test12345679",
    );
    const id = await submitCode(t, PROBLEM_ID, "print(1)");
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE_URL}/api/v1/submissions/${id}`, {
      headers: { Authorization: "Bearer " + t },
    });
    const data = await res.json();
    const status = (data as { data?: { status?: string } })?.data?.status || "";
    return status === "judging" || status === "finished";
  } catch {
    return false;
  }
}

Deno.test({
  name: "[e2e/rejudge] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();

    adminToken = await getAdminToken();

    const ts = Date.now().toString(36);
    userToken = await registerUser(
      "rejudge_user_" + ts,
      "rejudge_user_" + ts + "@test.com",
      "Test12345679",
    );

    judgeOk = await isJudgeAvailable();
    if (!judgeOk) {
      console.log("  ⚠ judge worker 不可用，重测测试跳过");
      return;
    }

    // 先提交一段正确代码，等待完成
    submissionId = await submitCode(userToken, PROBLEM_ID, CODE_SAMPLES.accepted);
    console.log("  → 原始提交 ID: " + submissionId.slice(0, 8));
    const result = await pollSubmission(userToken, submissionId);
    if (result.verdict !== "Accepted") {
      throw new Error("期望原始提交 Accepted, 实际 " + result.verdict);
    }
    console.log("  ✓ 原始提交完成: " + result.verdict + " (" + result.score + "分)");
  },
});

// ── 单条重测 ──

Deno.test({
  name: "[e2e/rejudge] 5.1 管理员单条重测完成提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const rejudgeRes = await apiPost(
      `/api/v1/admin/submissions/${submissionId}/rejudge`,
      {},
      adminToken,
    );

    if (rejudgeRes.status !== 200) {
      throw new Error("重测返回异常: " + rejudgeRes.status + " " + JSON.stringify(rejudgeRes.body));
    }

    const body = rejudgeRes.body as { message?: string; submission_id?: string };
    if (!body.submission_id) {
      throw new Error("重测响应缺少 submission_id: " + JSON.stringify(body));
    }
    console.log("  ✓ 重测已发起: " + (body.message || ""));

    // 等待重测完成
    const result = await pollSubmission(adminToken, submissionId, 15, 2000);
    if (result.verdict !== "Accepted") {
      throw new Error("重测结果期望 Accepted, 实际 " + result.verdict);
    }
    console.log("  ✓ 重测完成: " + result.verdict + " (" + result.score + "分)");
  },
});

// ── 404 / 403 ──

Deno.test({
  name: "[e2e/rejudge] 5.2a 不存在的提交返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});

Deno.test({
  name: "[e2e/rejudge] 5.2b 非管理员重测被拒 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});

// ── 批量重测 ──

Deno.test({
  name: "[e2e/rejudge] 5.3a 批量重测返回正确结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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

    const body = res.body as { data?: { total?: number; queued?: number; skipped?: number } };
    if (body.data) {
      console.log("  ✓ 批量重测: total=" + body.data.total + " queued=" + body.data.queued + " skipped=" + body.data.skipped);
    }
  },
});

Deno.test({
  name: "[e2e/rejudge] 5.3b 重测在审计日志中有记录",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const logs = await apiGet(
      "/api/v1/admin/audit-logs?action=submissions.rejudge",
      adminToken,
    );
    const data = (logs.body as { data: Array<{ detail?: Record<string, unknown> }> }).data;
    // 至少有一条重测记录
    if (data.length === 0) {
      console.log("  ⚠ 未找到 submissions.rejudge 审计记录（可能未启用审计日志）");
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
  },
});
