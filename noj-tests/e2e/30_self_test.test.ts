/**
 * 代码自测 E2E 测试（issue #221）。
 *
 * 覆盖：
 * - 创建自测并轮询到终态，返回分数/状态/输出
 * - 自测不写入正式提交历史
 * - 队列页展示自测条目（kind=self_test）
 */

import {
  apiGet,
  apiPost,
  e2eTest,
  getOrCreateUser,
  getProblemIdByNumber,
  isE2E,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

const USER_KEY = "self_test_user";
const ts = Date.now().toString(36);

let token = "";
let problemId = "";
let selfTestId = "";
let beforeSubmissionsTotal = 0;
let beforeTodayStatsTotal = 0;

async function pollSelfTest(
  id: string,
  timeoutMs = 90_000,
): Promise<{ status: string; score: number; output: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await apiGet(`/api/v1/self-tests/${id}`, token);
    if (res.status !== 200) {
      throw new Error(
        `查询自测失败: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    const data = (res.body as {
      data: {
        status: string;
        score: number;
        output: string | null;
      };
    }).data;
    if (data.status === "finished" || data.status === "error") {
      return data;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`自测轮询超时: ${id}`);
}

e2eTest("[e2e/self-test] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  const user = await getOrCreateUser(
    USER_KEY,
    `self_test_${ts}`,
    `self_test_${ts}@test.com`,
    TEST_PASSWORD,
  );
  token = user.token;
  problemId = await getProblemIdByNumber(1001);

  // 记录自测前的正式提交总数与今日统计
  const history = await apiGet("/api/v1/submissions", token);
  const body = history.body as { pagination?: { total?: number } };
  beforeSubmissionsTotal = body.pagination?.total ?? 0;

  const stats = await apiGet("/api/v1/submissions/today-stats", token);
  const statsBody = stats.body as { data?: { total?: number } };
  beforeTodayStatsTotal = statsBody.data?.total ?? 0;
});

e2eTest("[e2e/self-test] 创建自测并返回 id", async () => {
  if (!isE2E) return;
  const res = await apiPost(
    `/api/v1/problems/${problemId}/self-test`,
    {
      language: "python3",
      code: `from noj_solution_sdk import register

@register
def solve(text: str) -> str:
    return '{"gate_id":"E-07","status":"fault"}'
`,
    },
    token,
  );
  if (res.status !== 201) {
    throw new Error(`创建自测失败: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const data = (res.body as { data: { id: string; status: string } }).data;
  if (!data.id.startsWith("st_")) {
    throw new Error(`自测 ID 应以 st_ 开头: ${data.id}`);
  }
  selfTestId = data.id;
});

e2eTest("[e2e/self-test] 轮询到终态并返回分数/状态/输出", async () => {
  if (!isE2E) return;
  const result = await pollSelfTest(selfTestId);
  if (result.status !== "finished") {
    throw new Error(`自测未正常完成: ${JSON.stringify(result)}`);
  }
  if (typeof result.score !== "number") {
    throw new Error(`自测应返回分数: ${JSON.stringify(result)}`);
  }
  if (result.output === null) {
    throw new Error(`自测应返回输出: ${JSON.stringify(result)}`);
  }
});

e2eTest("[e2e/self-test] 自测后正式提交历史不变化", async () => {
  if (!isE2E) return;
  const history = await apiGet("/api/v1/submissions", token);
  const body = history.body as { pagination?: { total?: number } };
  const afterTotal = body.pagination?.total ?? 0;
  if (afterTotal !== beforeSubmissionsTotal) {
    throw new Error(
      `自测不应影响提交历史: before=${beforeSubmissionsTotal} after=${afterTotal}`,
    );
  }

  const stats = await apiGet("/api/v1/submissions/today-stats", token);
  const statsBody = stats.body as { data?: { total?: number } };
  const afterTodayStatsTotal = statsBody.data?.total ?? 0;
  if (afterTodayStatsTotal !== beforeTodayStatsTotal) {
    throw new Error(
      `自测不应影响今日统计: before=${beforeTodayStatsTotal} after=${afterTodayStatsTotal}`,
    );
  }
});

e2eTest("[e2e/self-test] 队列概览展示自测条目", async () => {
  if (!isE2E) return;
  const res = await apiGet("/api/v1/queue", token);
  if (res.status !== 200) {
    throw new Error(`获取队列失败: ${res.status}`);
  }
  const body = res.body as {
    pending?: Array<{ id: string; kind?: string }>;
    judging?: Array<{ id: string; kind?: string }>;
    recently_completed?: Array<{ id: string; kind?: string }>;
  };
  const allItems = [
    ...(body.pending ?? []),
    ...(body.judging ?? []),
    ...(body.recently_completed ?? []),
  ];
  const item = allItems.find((x) => x.id === selfTestId);
  if (!item || item.kind !== "self_test") {
    throw new Error(
      `队列概览中应包含自测条目且 kind=self_test: ${JSON.stringify(allItems)}`,
    );
  }
});
