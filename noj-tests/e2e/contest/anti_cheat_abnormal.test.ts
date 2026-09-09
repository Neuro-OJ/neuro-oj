/**
 * 竞赛防作弊异常场景 E2E。
 */
import {
  apiPost,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

let adminToken = "";
let userToken = "";
let contestId = "";

/** 读取 SSE 流 `ms` 毫秒，返回收到的原始帧文本。 */
async function readSseFrames(
  res: Response,
  ms: number,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let buffer = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("contest:submission:created")) break;
  }
  await reader.cancel().catch(() => {});
  return buffer;
}

async function publishContestSubmissionEvent(
  contestId: string,
): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: [
        "exec",
        "noj-e2e-redis",
        "redis-cli",
        "PUBLISH",
        `noj:events:contest:${contestId}:submission`,
        JSON.stringify({ submission_id: "s1", user_id: "secret-user" }),
      ],
    });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}

e2eTest("[e2e/anti-cheat-abnormal] Setup", async () => {
  if (!isE2E) return;
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  userToken = await registerUser(
    "ac_user_" + ts,
    "ac_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  const problemId = await getProblemIdByNumber(1001);
  const now = Date.now();
  const res = await apiPost(
    "/api/v1/admin/contest/contests",
    {
      title: "AC Abnormal " + ts,
      type: "kaggle",
      kind: "public",
      start_time: new Date(now - 3600_000).toISOString(),
      end_time: new Date(now + 3600_000).toISOString(),
      is_public: true,
      affect_global_ranking: false,
      config: {},
      problems: [{
        problem_id: problemId,
        sort_order: 0,
        label: "A",
        score: 100,
      }],
    },
    adminToken,
  );
  if (res.status !== 201) throw new Error("创建竞赛失败 " + res.status);
  contestId = (res.body as { data: { id: string } }).data.id;
});

e2eTest("[e2e/anti-cheat-abnormal] 未报名用户收不到提交事件", async () => {
  if (!isE2E) return;
  // 公开赛：未报名用户可以订阅（榜单事件），但不得收到任何提交事件帧。
  const res = await fetch(
    `http://localhost:8099/api/v1/contests/${contestId}/events`,
    { headers: { Authorization: "Bearer " + userToken } },
  );
  if (res.status !== 200) {
    throw new Error(`公开赛订阅应 200，实际 ${res.status}`);
  }
  const published = await publishContestSubmissionEvent(contestId);
  if (!published) throw new Error("docker exec noj-e2e-redis 发布事件失败");
  const frames = await readSseFrames(res, 5_000);
  if (frames.includes("contest:submission:created")) {
    throw new Error(`未报名用户收到了提交事件帧: ${frames.slice(0, 200)}`);
  }
});

e2eTest(
  "[e2e/anti-cheat-abnormal] 报名用户收到提交事件但不含 user_id",
  async () => {
    if (!isE2E) return;
    const reg = await apiPost(
      `/api/v1/contests/${contestId}/register`,
      {},
      userToken,
    );
    if (reg.status !== 200 && reg.status !== 201) {
      throw new Error(`报名失败: ${reg.status}`);
    }
    const res = await fetch(
      `http://localhost:8099/api/v1/contests/${contestId}/events`,
      { headers: { Authorization: "Bearer " + userToken } },
    );
    if (res.status !== 200) {
      throw new Error(`报名用户订阅应 200，实际 ${res.status}`);
    }
    const published = await publishContestSubmissionEvent(contestId);
    if (!published) throw new Error("docker exec noj-e2e-redis 发布事件失败");
    const frames = await readSseFrames(res, 10_000);
    if (!frames.includes("contest:submission:created")) {
      throw new Error("报名用户未在 10s 内收到提交事件帧");
    }
    if (frames.includes("secret-user") || frames.includes('"user_id"')) {
      throw new Error(`提交事件帧泄露 user_id: ${frames.slice(0, 200)}`);
    }
  },
);
