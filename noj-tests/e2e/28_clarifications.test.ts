/**
 * 竞赛答疑（Clarification）E2E 测试。
 *
 * 覆盖：参赛者提问（挂题目/全局）、非参赛者提问被拒、非进行期间提问被拒、
 * admin 公开/私密回复、回复通知（community_notifications + SSE）、
 * 答疑列表可见性（未参赛仅公开 / 参赛者见自己的私密 / admin 见全部）。
 */

import {
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

const testSuffix = Date.now().toString(36);
let adminToken = "";
let participantToken = "";
let otherParticipantToken = "";
let outsiderToken = "";
let contestId = "";
let problemId = "";

interface ClarificationData {
  id: string;
  problem_label: string | null;
  content: string;
  is_public: boolean;
  replies: Array<{ id: string; content: string; is_public: boolean }>;
}

interface NotificationItem {
  notification: {
    type: string;
    data: Record<string, unknown>;
    id: string;
  };
}

e2eTest("[e2e/clarifications] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  participantToken = await registerUser(
    `clar_asker_${testSuffix}`,
    `clar_asker_${testSuffix}@test.com`,
    TEST_PASSWORD,
  );
  otherParticipantToken = await registerUser(
    `clar_other_${testSuffix}`,
    `clar_other_${testSuffix}@test.com`,
    TEST_PASSWORD,
  );
  outsiderToken = await registerUser(
    `clar_outsider_${testSuffix}`,
    `clar_outsider_${testSuffix}@test.com`,
    TEST_PASSWORD,
  );
  problemId = await getProblemIdByNumber(1001);
});

e2eTest("[e2e/clarifications] 1. 创建进行中的竞赛并注册参赛者", async () => {
  if (!isE2E) return;
  const now = Date.now();
  const createResult = await apiPost(
    "/api/v1/admin/contests",
    {
      title: `E2E 答疑竞赛 ${testSuffix}`,
      start_time: new Date(now - 60 * 60 * 1000).toISOString(),
      end_time: new Date(now + 60 * 60 * 1000).toISOString(),
      type: "kaggle",
      config: {
        penalty_minutes: 20,
        freeze_time: null,
        unfreeze_after_end: true,
      },
      is_public: true,
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
  if (createResult.status !== 201) {
    throw new Error(
      `创建竞赛失败: ${createResult.status} ${
        JSON.stringify(createResult.body)
      }`,
    );
  }
  contestId = (createResult.body as { data: { id: string } }).data.id;

  for (const token of [participantToken, otherParticipantToken]) {
    const registerResult = await apiPost(
      `/api/v1/contests/${contestId}/register`,
      undefined,
      token,
    );
    if (registerResult.status !== 201) {
      throw new Error(
        `注册竞赛失败: ${registerResult.status} ${
          JSON.stringify(registerResult.body)
        }`,
      );
    }
  }
});

e2eTest("[e2e/clarifications] 2. 参赛者提问（挂题目 + 全局）", async () => {
  if (!isE2E) return;
  const withProblem = await apiPost(
    `/api/v1/contests/${contestId}/clarifications`,
    { content: "样例输入第三行是什么含义？", problem_id: problemId },
    participantToken,
  );
  if (withProblem.status !== 201) {
    throw new Error(
      `挂题目提问失败: ${withProblem.status} ${
        JSON.stringify(withProblem.body)
      }`,
    );
  }
  const question = withProblem.body as { data: ClarificationData };
  if (question.data.problem_label !== "A" || !question.data.is_public) {
    throw new Error(`提问响应字段异常: ${JSON.stringify(question.data)}`);
  }

  const globalQuestion = await apiPost(
    `/api/v1/contests/${contestId}/clarifications`,
    { content: "罚时规则如何计算？" },
    participantToken,
  );
  if (globalQuestion.status !== 201) {
    throw new Error(
      `全局提问失败: ${globalQuestion.status} ${
        JSON.stringify(globalQuestion.body)
      }`,
    );
  }
});

e2eTest(
  "[e2e/clarifications] 3. 非参赛者提问被拒，非进行期间提问被拒",
  async () => {
    if (!isE2E) return;
    const forbidden = await apiPost(
      `/api/v1/contests/${contestId}/clarifications`,
      { content: "非参赛者提问" },
      outsiderToken,
    );
    if (forbidden.status !== 403) {
      throw new Error(`非参赛者提问应 403，实际 ${forbidden.status}`);
    }

    // 已结束竞赛：先建赛后改时间窗口（ended 竞赛无法注册）
    const now = Date.now();
    const endedCreate = await apiPost(
      "/api/v1/admin/contests",
      {
        title: `E2E 已结束答疑竞赛 ${testSuffix}`,
        start_time: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(now - 60 * 60 * 1000).toISOString(),
        type: "kaggle",
        config: {
          penalty_minutes: 20,
          freeze_time: null,
          unfreeze_after_end: true,
        },
        is_public: true,
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
    const endedContestId =
      (endedCreate.body as { data: { id: string } }).data.id;
    const registerResult = await apiPost(
      `/api/v1/contests/${endedContestId}/register`,
      undefined,
      participantToken,
    );
    if (registerResult.status !== 403) {
      throw new Error(`已结束竞赛注册应 403，实际 ${registerResult.status}`);
    }

    // spec: pending / ended 期间提问 MUST 403（需已注册参赛者身份）
    // pending 竞赛：创建未来窗口竞赛，注册后赛前提问
    const pendingCreate = await apiPost(
      "/api/v1/admin/contests",
      {
        title: `E2E 待开始答疑竞赛 ${testSuffix}`,
        start_time: new Date(now + 60 * 60 * 1000).toISOString(),
        end_time: new Date(now + 120 * 60 * 1000).toISOString(),
        type: "kaggle",
        config: {
          penalty_minutes: 20,
          freeze_time: null,
          unfreeze_after_end: true,
        },
        is_public: true,
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
    if (pendingCreate.status !== 201) {
      throw new Error(
        `创建待开始竞赛失败: ${pendingCreate.status} ${
          JSON.stringify(pendingCreate.body)
        }`,
      );
    }
    const pendingContestId =
      (pendingCreate.body as { data: { id: string } }).data.id;
    const pendingRegister = await apiPost(
      `/api/v1/contests/${pendingContestId}/register`,
      undefined,
      participantToken,
    );
    if (pendingRegister.status !== 201) {
      throw new Error(
        `待开始竞赛注册应 201，实际 ${pendingRegister.status} ${
          JSON.stringify(pendingRegister.body)
        }`,
      );
    }
    const pendingAsk = await apiPost(
      `/api/v1/contests/${pendingContestId}/clarifications`,
      { content: "赛前提问" },
      participantToken,
    );
    if (pendingAsk.status !== 403) {
      throw new Error(
        `pending 竞赛提问应 403，实际 ${pendingAsk.status} ${
          JSON.stringify(pendingAsk.body)
        }`,
      );
    }

    // ended 竞赛：无法注册，先建 running 窗口竞赛注册，再由 admin 改为已结束
    const endedAskCreate = await apiPost(
      "/api/v1/admin/contests",
      {
        title: `E2E 赛后提问竞赛 ${testSuffix}`,
        start_time: new Date(now - 60 * 60 * 1000).toISOString(),
        end_time: new Date(now + 60 * 60 * 1000).toISOString(),
        type: "kaggle",
        config: {
          penalty_minutes: 20,
          freeze_time: null,
          unfreeze_after_end: true,
        },
        is_public: true,
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
    const endedAskContestId =
      (endedAskCreate.body as { data: { id: string } }).data.id;
    const endedAskRegister = await apiPost(
      `/api/v1/contests/${endedAskContestId}/register`,
      undefined,
      participantToken,
    );
    if (endedAskRegister.status !== 201) {
      throw new Error(
        `running 竞赛注册应 201，实际 ${endedAskRegister.status} ${
          JSON.stringify(endedAskRegister.body)
        }`,
      );
    }
    const endContest = await apiPut(
      `/api/v1/admin/contests/${endedAskContestId}`,
      { end_time: new Date(now - 1000).toISOString() },
      adminToken,
    );
    if (endContest.status !== 200) {
      throw new Error(
        `结束竞赛失败: ${endContest.status} ${JSON.stringify(endContest.body)}`,
      );
    }
    const endedAsk = await apiPost(
      `/api/v1/contests/${endedAskContestId}/clarifications`,
      { content: "赛后提问" },
      participantToken,
    );
    if (endedAsk.status !== 403) {
      throw new Error(
        `ended 竞赛提问应 403，实际 ${endedAsk.status} ${
          JSON.stringify(endedAsk.body)
        }`,
      );
    }
  },
);

e2eTest(
  "[e2e/clarifications] 4. admin 公开与私密回复，非主办方回复被拒",
  async () => {
    if (!isE2E) return;
    const listResult = await apiGet(
      `/api/v1/contests/${contestId}/clarifications`,
      adminToken,
    );
    if (listResult.status !== 200) {
      throw new Error(
        `答疑列表失败: ${listResult.status} ${JSON.stringify(listResult.body)}`,
      );
    }
    const items = (listResult.body as { data: ClarificationData[] }).data;
    const target = items.find((item) => item.content.includes("样例输入"));
    if (!target) throw new Error("未找到挂题目提问");

    // admin 公开回复
    const publicReply = await apiPost(
      `/api/v1/contests/${contestId}/clarifications/${target.id}/reply`,
      { content: "第三行是边界数据。", is_public: true },
      adminToken,
    );
    if (publicReply.status !== 201) {
      throw new Error(
        `公开回复失败: ${publicReply.status} ${
          JSON.stringify(publicReply.body)
        }`,
      );
    }

    // admin 私密回复
    const privateReply = await apiPost(
      `/api/v1/contests/${contestId}/clarifications/${target.id}/reply`,
      { content: "注意初始化变量。", is_public: false },
      adminToken,
    );
    if (privateReply.status !== 201) {
      throw new Error(
        `私密回复失败: ${privateReply.status} ${
          JSON.stringify(privateReply.body)
        }`,
      );
    }

    // 非主办方（其他参赛者）回复被拒
    const forbiddenReply = await apiPost(
      `/api/v1/contests/${contestId}/clarifications/${target.id}/reply`,
      { content: "我也回复", is_public: true },
      otherParticipantToken,
    );
    if (forbiddenReply.status !== 403) {
      throw new Error(`非主办方回复应 403，实际 ${forbiddenReply.status}`);
    }

    // 回复不存在的提问
    const notFound = await apiPost(
      `/api/v1/contests/${contestId}/clarifications/00000000-0000-0000-0000-000000000000/reply`,
      { content: "x", is_public: true },
      adminToken,
    );
    if (notFound.status !== 404) {
      throw new Error(`回复不存在提问应 404，实际 ${notFound.status}`);
    }
  },
);

e2eTest("[e2e/clarifications] 5. 提问者收到 clarification 通知", async () => {
  if (!isE2E) return;
  const notificationsResult = await apiGet(
    "/api/v1/community/notifications?limit=30",
    participantToken,
  );
  if (notificationsResult.status !== 200) {
    throw new Error(
      `通知列表失败: ${notificationsResult.status} ${
        JSON.stringify(notificationsResult.body)
      }`,
    );
  }
  const notifications = (
    notificationsResult.body as { data: NotificationItem[] }
  ).data;
  const clarificationNotification = notifications.find(
    (item) =>
      item.notification.type === "clarification" &&
      item.notification.data.contest_id === contestId,
  );
  if (!clarificationNotification) {
    throw new Error(
      `提问者未收到 clarification 通知: ${JSON.stringify(notifications)}`,
    );
  }
});

e2eTest("[e2e/clarifications] 6. 答疑列表可见性", async () => {
  if (!isE2E) return;
  const fetchList = async (
    token?: string,
  ): Promise<ClarificationData[]> => {
    const res = await apiGet(
      `/api/v1/contests/${contestId}/clarifications`,
      token,
    );
    if (res.status !== 200) {
      throw new Error(
        `答疑列表失败: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return (res.body as { data: ClarificationData[] }).data;
  };

  // 提问者：见公开 + 自己的私密回复
  const askerView = await fetchList(participantToken);
  const askerTarget = askerView.find((item) =>
    item.content.includes("样例输入")
  );
  if (!askerTarget || askerTarget.replies.length !== 2) {
    throw new Error(
      `提问者应看到 2 条回复（公开+私密）: ${JSON.stringify(askerView)}`,
    );
  }

  // 其他参赛者：仅公开回复
  const otherView = await fetchList(otherParticipantToken);
  const otherTarget = otherView.find((item) =>
    item.content.includes("样例输入")
  );
  if (!otherTarget || otherTarget.replies.length !== 1) {
    throw new Error(
      `其他参赛者应仅看到公开回复: ${JSON.stringify(otherView)}`,
    );
  }

  // 非参赛者：仅公开
  const outsiderView = await fetchList(outsiderToken);
  const outsiderTarget = outsiderView.find((item) =>
    item.content.includes("样例输入")
  );
  if (!outsiderTarget || outsiderTarget.replies.length !== 1) {
    throw new Error(
      `非参赛者应仅看到公开回复: ${JSON.stringify(outsiderView)}`,
    );
  }

  // 匿名：仅公开
  const anonymousView = await fetchList();
  const anonymousTarget = anonymousView.find((item) =>
    item.content.includes("样例输入")
  );
  if (!anonymousTarget || anonymousTarget.replies.length !== 1) {
    throw new Error(
      `匿名应仅看到公开回复: ${JSON.stringify(anonymousView)}`,
    );
  }

  // admin：全部
  const adminView = await fetchList(adminToken);
  const adminTarget = adminView.find((item) =>
    item.content.includes("样例输入")
  );
  if (!adminTarget || adminTarget.replies.length !== 2) {
    throw new Error(
      `admin 应看到全部回复: ${JSON.stringify(adminView)}`,
    );
  }
});
