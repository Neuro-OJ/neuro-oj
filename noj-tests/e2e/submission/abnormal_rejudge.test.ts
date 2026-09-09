/**
 * 提交异常与重测并发 E2E。
 */
import {
  apiGet,
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
} from "../helper.ts";

let token = "";
let adminToken = "";
let PROBLEM_ID = "";

e2eTest("[e2e/submission-abnormal] Setup", async () => {
  if (!isE2E) return;
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  token = await registerUser(
    "abn_user_" + ts,
    "abn_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  PROBLEM_ID = await getProblemIdByNumber(1001);
});

e2eTest("[e2e/submission-abnormal] 重测不存在的提交返回 404", async () => {
  if (!isE2E) return;
  const { status } = await apiPost(
    "/api/v1/admin/submission/submissions/00000000-0000-0000-0000-000000000000/rejudge",
    {},
    adminToken,
  );
  if (status !== 404) throw new Error("期望 404，实际 " + status);
});

e2eTest("[e2e/submission-abnormal] 并发重测同一提交不崩溃", async () => {
  if (!isE2E) return;
  const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
  const results = await Promise.all([
    apiPost(
      `/api/v1/admin/submission/submissions/${id}/rejudge`,
      {},
      adminToken,
    ),
    apiPost(
      `/api/v1/admin/submission/submissions/${id}/rejudge`,
      {},
      adminToken,
    ),
  ]);
  for (const r of results) {
    if (
      r.status !== 200 && r.status !== 400 && r.status !== 409 &&
      r.status !== 202
    ) {
      throw new Error("并发重测返回意外状态 " + r.status);
    }
  }
});

e2eTest(
  "[e2e/submission-abnormal] 评测失败后状态为 error 且可查看",
  async () => {
    if (!isE2E) return;
    // 使用必然运行失败的代码（语法错误）
    const id = await submitCode(token, PROBLEM_ID, "def broken(:\n");
    const result = await pollSubmission(token, id, 45, 2000, true);
    // 语法错误的代码必然评测失败：状态必须是 error（不是 finished）。
    if (result.status !== "error") {
      throw new Error("语法错误提交应最终为 error，实际 " + result.status);
    }
    const { status, body } = await apiGet(`/api/v1/submissions/${id}`, token);
    if (status !== 200) throw new Error("期望 200，实际 " + status);
    const d = body as { data?: { status?: string } };
    if (d.data?.status !== "error") {
      throw new Error("失败提交应最终为 error，实际 " + d.data?.status);
    }
  },
);
