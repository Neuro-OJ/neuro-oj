/**
 * 竞赛防作弊攻击剧本 E2E。
 *
 * 覆盖 7 个场景（对应 2026-09-05-contest-anti-cheat-fix-plan Task 18 / spec §12）：
 * 1. 无上下文直取私有题 → 404；
 * 2. 客观题普通入口携带伪造 contestId → 400；
 * 3. 竞赛入口重复提交超 submission_limits → 429；普通入口对私有题 → 404；
 * 4. 其他域私有题加入本域竞赛/题单 → 404；
 * 5. 非参赛者订阅 SSE contestSubmission → 无事件；
 * 6. 赛中提交详情/全局队列不泄判据；
 * 7. 客观题练习提交不泄 expected（private paper）。
 *
 * 私有题属于独立成员域；通过正式 API 初始化角色与发布依据，不写数据库兜底。
 */
import {
  api,
  apiGet,
  apiPost,
  apiPut,
  BASE_URL,
  e2eTest,
  getAdminToken,
  getAnswerVersionId,
  getOrCreateUser,
  getProblemIdByNumber,
  isE2E,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

const ts = Date.now().toString(36);

let adminToken = "";
let ownerToken = "";
let attackerToken = "";
let participantToken = "";
let publicProblemId = "";
let publicVersionId = "";
let privatePaperId = "";
let privateNumber = 0;
const privateDomain = `ac-private-${ts}`;
const paperPath = () =>
  `/api/v1/domains/${privateDomain}/problems/${privateNumber}`;
let privateVersionId = "";
let privateQuestionId = "";

// 竞赛上下文
let sseContestId = "";
let limitContestId = "";
let contestSubmissionId = "";

/** 私有资源属于独立成员域；普通默认域编辑者仍不能读取或引用。 */
async function createPrivatePaper(
  token: string,
  title: string,
): Promise<string> {
  const domain = await apiPost("/api/v1/domains", {
    slug: privateDomain,
    name: title,
    preset: "education",
  }, adminToken);
  if (domain.status !== 201) {
    throw new Error(`创建私有域失败 ${JSON.stringify(domain)}`);
  }
  const invite = await apiPost(`/api/v1/domains/${privateDomain}/invitations`, {
    email: `anticheat_owner_${ts}@test.com`,
  }, adminToken);
  if (invite.status !== 201) {
    throw new Error(`邀请负责人失败 ${JSON.stringify(invite)}`);
  }
  const accepted = await apiPost("/api/v1/domain-invitations/accept", {
    token: (invite.body as { data: { token: string } }).data.token,
  }, token);
  if (accepted.status !== 200) {
    throw new Error(`接受邀请失败 ${JSON.stringify(accepted)}`);
  }
  const identity = await apiGet("/api/v1/auth/me", token);
  const transfer = await apiPost(`/api/v1/domains/${privateDomain}/transfer`, {
    user_id: (identity.body as { data: { id: string } }).data.id,
  }, adminToken);
  if (transfer.status !== 200) {
    throw new Error(`交接负责人失败 ${JSON.stringify(transfer)}`);
  }
  const created = await apiPost(`/api/v1/domains/${privateDomain}/problems`, {
    title,
    description: "私有域防作弊套卷",
    is_objective: true,
  }, token);
  if (created.status !== 201) {
    throw new Error(`创建私有套卷失败 ${JSON.stringify(created)}`);
  }
  const problem = created.body as { problem_id: string; number: number };
  privateNumber = problem.number;
  return problem.problem_id;
}

/**
 * 创建运行中的竞赛。
 *
 * 0.11 起比赛不再区分公开赛/邀请赛，也没有比赛密码：可见性与报名都由域访问权决定，
 * 因此请求体不带 `kind` / `is_public` / `password`（带上会被 400 拒绝）。非参赛者
 * 隔离场景靠"不报名"来表达，不靠 `is_public=false`。
 */
async function createContest(
  title: string,
  opts: {
    problemId: string;
    submissionLimit?: number;
  },
): Promise<string> {
  const now = Date.now();
  const body: Record<string, unknown> = {
    title,
    start_time: new Date(now - 60 * 60 * 1000).toISOString(),
    end_time: new Date(now + 60 * 60 * 1000).toISOString(),
    type: "kaggle",
    config: opts.submissionLimit === undefined
      ? {}
      : { submission_limits: { [opts.problemId]: opts.submissionLimit } },
    affect_global_ranking: false,
    problems: [{
      problem_id: opts.problemId,
      sort_order: 0,
      label: "A",
      score: 100,
    }],
  };
  const res = await apiPost("/api/v1/admin/contest/contests", body, adminToken);
  if (res.status !== 201) {
    throw new Error(
      `创建竞赛失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

/** 读取 SSE 流中的 event 名称；连接失败/非 2xx 按无事件处理。 */
async function readSSEEventNames(
  path: string,
  token: string,
  timeoutMs = 3000,
): Promise<string[]> {
  const events: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return events;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          events.push(trimmed.slice(6).trim());
        }
      }
    }
    return events;
  } catch {
    return events;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

e2eTest("[e2e/anti-cheat] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();

  adminToken = await getAdminToken();
  const owner = await getOrCreateUser(
    "anticheat_owner_" + ts,
    `anticheat_owner_${ts}`,
    `anticheat_owner_${ts}@test.com`,
    TEST_PASSWORD,
  );
  ownerToken = owner.token;
  const attacker = await getOrCreateUser(
    "anticheat_attacker_" + ts,
    `anticheat_attacker_${ts}`,
    `anticheat_attacker_${ts}@test.com`,
    TEST_PASSWORD,
  );
  attackerToken = attacker.token;
  const participant = await getOrCreateUser(
    "anticheat_participant_" + ts,
    `anticheat_participant_${ts}`,
    `anticheat_participant_${ts}@test.com`,
    TEST_PASSWORD,
  );
  participantToken = participant.token;

  publicProblemId = await getProblemIdByNumber(1001);
  privatePaperId = await createPrivatePaper(
    ownerToken,
    `E2E 防作弊私有套卷 ${ts}`,
  );

  const draft = await apiGet(`${paperPath()}/draft`, ownerToken);
  if (draft.status !== 200) {
    throw new Error(`读取草稿失败 ${JSON.stringify(draft)}`);
  }
  const revision = (draft.body as { revision: number }).revision;
  privateQuestionId = crypto.randomUUID();
  const saved = await api("PUT", `${paperPath()}/draft`, {
    token: ownerToken,
    headers: { "If-Match": String(revision) },
    body: {
      content: {
        kind: "objective",
        title: `E2E 私有卷 ${ts}`,
        description: "私有域套卷",
        samples: [],
        questions: [{
          key: privateQuestionId,
          sort_order: 0,
          type: "single",
          prompt: "私有套卷唯一题",
          options: [{ key: "A", text: "正确项" }, { key: "B", text: "错误项" }],
          answer: ["A"],
          explanation: "私有解析",
        }],
      },
    },
  });
  if (saved.status !== 200) {
    throw new Error(`保存草稿失败 ${JSON.stringify(saved)}`);
  }
  const published = await api("POST", `${paperPath()}/publish`, {
    token: ownerToken,
    headers: {
      "If-Match": String((saved.body as { revision: number }).revision),
    },
    body: { change_note: "E2E 私有套卷 V1" },
  });
  if (published.status !== 200) {
    throw new Error(`发布私有卷失败 ${JSON.stringify(published)}`);
  }
  privateVersionId = (published.body as { version_id: string }).version_id;
  // 攻击者有 main 的资源权限，拒绝原因必须来自外域资源归属而非缺少建题单权限。
  const inviteAttacker = await apiPost("/api/v1/domains/main/invitations", {
    email: `anticheat_attacker_${ts}@test.com`,
  }, adminToken);
  if (inviteAttacker.status !== 201) {
    throw new Error(`邀请默认域编辑者失败 ${JSON.stringify(inviteAttacker)}`);
  }
  const acceptedAttacker = await apiPost("/api/v1/domain-invitations/accept", {
    token: (inviteAttacker.body as { data: { token: string } }).data.token,
  }, attackerToken);
  if (acceptedAttacker.status !== 200) {
    throw new Error(`编辑者加入失败 ${JSON.stringify(acceptedAttacker)}`);
  }
  const attackerIdentity = await apiGet("/api/v1/auth/me", attackerToken);
  const roles = await apiPut(
    `/api/v1/domains/main/members/${
      (attackerIdentity.body as { data: { id: string } }).data.id
    }/roles`,
    { roles: ["editor"] },
    adminToken,
  );
  if (roles.status !== 200) {
    throw new Error(`域角色授权失败 ${JSON.stringify(roles)}`);
  }
  publicVersionId = await getAnswerVersionId(adminToken, publicProblemId) ?? "";
  if (!publicVersionId) {
    throw new Error(`共享题目 ${publicProblemId} 没有已发布作答版本`);
  }

  // SSE 隔离场景：注册参赛者供后续触发提交；非参赛者就是"没报名的人"
  sseContestId = await createContest(`E2E SSE 防作弊赛 ${ts}`, {
    problemId: publicProblemId,
  });
  const regSse = await apiPost(
    `/api/v1/contests/${sseContestId}/register`,
    {},
    participantToken,
  );
  if (regSse.status !== 201) {
    throw new Error(
      `SSE 赛参赛者注册失败: ${regSse.status} ${JSON.stringify(regSse.body)}`,
    );
  }

  // 限额赛：submission_limits=1，用于 429 与赛中详情/队列场景
  limitContestId = await createContest(`E2E 限额防作弊赛 ${ts}`, {
    problemId: publicProblemId,
    submissionLimit: 1,
  });
  const regLimit = await apiPost(
    `/api/v1/contests/${limitContestId}/register`,
    {},
    participantToken,
  );
  if (regLimit.status !== 201) {
    throw new Error(
      `限额赛参赛者注册失败: ${regLimit.status} ${
        JSON.stringify(regLimit.body)
      }`,
    );
  }
});

e2eTest("[e2e/anti-cheat] 1. 无上下文直取私有题 → 404", async () => {
  if (!isE2E) return;
  const anon = await apiGet(paperPath());
  if (anon.status !== 404) {
    throw new Error(`匿名读取私有题应 404，实际 ${anon.status}`);
  }
  const asOther = await apiGet(
    paperPath(),
    attackerToken,
  );
  if (asOther.status !== 404) {
    throw new Error(`非 owner 读取私有题应 404，实际 ${asOther.status}`);
  }
  const questions = await apiGet(
    paperPath(),
    attackerToken,
  );
  if (questions.status !== 404) {
    throw new Error(
      `非 owner 读取私有套卷小题应 404，实际 ${questions.status}`,
    );
  }
  const ownerView = await apiGet(
    paperPath(),
    ownerToken,
  );
  if (ownerView.status !== 200) {
    throw new Error(`owner 应可读自己的私有题，实际 ${ownerView.status}`);
  }
});

e2eTest(
  "[e2e/anti-cheat] 2. 普通客观题入口携带伪造 contestId → 400",
  async () => {
    if (!isE2E) return;
    // 客观题提交入口支持携带 contest_id：攻击者用真实存在的非公开赛 ID，
    // 但该套卷不属于该赛/攻击者未注册，服务层必须拒绝伪造的竞赛上下文。
    const res = await apiPost(
      `${paperPath()}/objective-submissions`,
      {
        answers: { [privateQuestionId]: ["A"] },
        contest_id: sseContestId,
        version_id: privateVersionId,
      },
      attackerToken,
    );
    if (
      res.status !== 400 ||
      (res.body as { error: string }).error !== "交卷上下文由使用域入口解析"
    ) {
      throw new Error(
        `伪造上下文必须在解析时拒绝，实际 ${JSON.stringify(res)}`,
      );
    }
  },
);

e2eTest(
  "[e2e/anti-cheat] 3. 竞赛入口重复提交超 submission_limits → 429；普通入口私有题 → 404",
  async () => {
    if (!isE2E) return;
    const first = await apiPost(
      `/api/v1/contests/${limitContestId}/submit`,
      {
        problem_id: publicProblemId,
        language: "python3",
        code: "print(1)",
        version_id: publicVersionId,
      },
      participantToken,
    );
    if (first.status !== 201) {
      throw new Error(
        `竞赛首次提交应 201，实际 ${first.status} ${
          JSON.stringify(first.body)
        }`,
      );
    }
    contestSubmissionId = (first.body as { data: { id: string } }).data.id;

    const second = await apiPost(
      `/api/v1/contests/${limitContestId}/submit`,
      {
        problem_id: publicProblemId,
        language: "python3",
        code: "print(2)",
        version_id: publicVersionId,
      },
      participantToken,
    );
    if (second.status !== 429) {
      throw new Error(`第二次竞赛提交应 429，实际 ${second.status}`);
    }

    const ordinary = await apiPost(
      "/api/v1/submissions",
      {
        problem_id: privatePaperId,
        language: "python3",
        code: "print('steal')",
        version_id: privateVersionId,
      },
      attackerToken,
    );
    if (ordinary.status !== 404) {
      throw new Error(`普通入口提交他人私有题应 404，实际 ${ordinary.status}`);
    }
  },
);

e2eTest("[e2e/anti-cheat] 4. 其他域私有题加入本域竞赛/题单 → 404", async () => {
  if (!isE2E) return;
  // 4.1 攻击者创建自己的比赛（0.11 无 kind/password），但尝试加入别人的私有套卷
  const now = Date.now();
  const contestRes = await apiPost(
    "/api/v1/contests",
    {
      title: `E2E 攻击者建赛 ${ts}`,
      start_time: new Date(now - 60 * 60 * 1000).toISOString(),
      end_time: new Date(now + 60 * 60 * 1000).toISOString(),
      type: "kaggle",
      config: {},
      affect_global_ranking: false,
      problems: [{
        problem_id: privatePaperId,
        sort_order: 0,
        label: "A",
        score: 100,
      }],
    },
    attackerToken,
  );
  if (contestRes.status !== 404) {
    throw new Error(
      `把他人私有题加入自己竞赛应 404，实际 ${contestRes.status}`,
    );
  }

  // 4.2 攻击者创建私有题单并加入别人的私有套卷
  const trainingRes = await apiPost(
    "/api/v1/trainings",
    { title: `E2E 攻击者题单 ${ts}`, visibility: "private" },
    attackerToken,
  );
  if (trainingRes.status !== 201) {
    throw new Error(
      `创建题单失败: ${trainingRes.status} ${JSON.stringify(trainingRes.body)}`,
    );
  }
  const trainingId = (trainingRes.body as { data: { id: string } }).data.id;
  const addRes = await apiPost(
    `/api/v1/trainings/${trainingId}/problems`,
    { problem_id: privatePaperId },
    attackerToken,
  );
  if (addRes.status !== 404) {
    throw new Error(
      `把他人私有题加入自己题单应 404，实际 ${addRes.status}`,
    );
  }
});

e2eTest(
  "[e2e/anti-cheat] 5. 非参赛者订阅 SSE contestSubmission → 无事件",
  async () => {
    if (!isE2E) return;
    // 非参赛者打开非公开赛 SSE。当前实现返回 404（无法订阅），同样满足“无事件”。
    // 若未来成员校验放宽为可连接但不推送，这里也会在事件收集后断言无 submission 事件。
    const eventsPromise = readSSEEventNames(
      `/api/v1/contests/${sseContestId}/events`,
      attackerToken,
      3000,
    );
    // 触发一次参赛者提交，验证非参赛者的流中不会出现 contest:submission:created
    const submit = await apiPost(
      `/api/v1/contests/${sseContestId}/submit`,
      {
        problem_id: publicProblemId,
        language: "python3",
        code: "print(1)",
        version_id: publicVersionId,
      },
      participantToken,
    );
    if (submit.status !== 201) {
      throw new Error(
        `SSE 赛参赛者提交失败: ${submit.status} ${JSON.stringify(submit.body)}`,
      );
    }
    const events = await eventsPromise;
    if (events.includes("contest:submission:created")) {
      throw new Error(
        `非参赛者不应收到 contest:submission:created，实际 ${events.join(",")}`,
      );
    }
  },
);

e2eTest("[e2e/anti-cheat] 6. 赛中提交详情/全局队列不泄判据", async () => {
  if (!isE2E) return;
  if (!contestSubmissionId) {
    throw new Error("场景 3 未产生竞赛提交，无法执行场景 6");
  }

  // 6.1 非参赛者查看竞赛提交详情：仅存在级定位，不包含成绩或判据。
  const detail = await apiGet(
    `/api/v1/submissions/${contestSubmissionId}`,
    attackerToken,
  );
  if (detail.status !== 200) {
    throw new Error(
      `竞赛提交详情应可读（存在级），实际 ${detail.status}`,
    );
  }
  const data = (detail.body as { data: Record<string, unknown> }).data;
  if (
    Object.keys(data).length !== 4 ||
    data.id !== contestSubmissionId ||
    data.problem_id !== publicProblemId ||
    data.contest_id !== limitContestId ||
    typeof data.status !== "string"
  ) {
    throw new Error(
      `非参赛者详情应仅含 {id, problem_id, contest_id, status}，实际 ${
        JSON.stringify(data)
      }`,
    );
  }
  if (
    "score" in data || "result" in data || "details" in data ||
    "output" in data || "code" in data
  ) {
    throw new Error(`非参赛者详情泄露判据: ${JSON.stringify(data)}`);
  }

  // 6.2 非参赛者查看全局队列：竞赛提交必须隐藏
  const queue = await apiGet("/api/v1/queue", attackerToken);
  if (queue.status !== 200) {
    throw new Error(`全局队列应 200，实际 ${queue.status}`);
  }
  const queueBody = queue.body as {
    pending: Array<{ id: string }>;
    judging: Array<{ id: string }>;
    recently_completed: Array<{ id: string }>;
  };
  const allIds = [
    ...queueBody.pending.map((r) => r.id),
    ...queueBody.judging.map((r) => r.id),
    ...queueBody.recently_completed.map((r) => r.id),
  ];
  if (allIds.includes(contestSubmissionId)) {
    throw new Error(`全局队列不应泄露竞赛提交: ${contestSubmissionId}`);
  }

  // 6.3 参赛者本人查看详情：赛中可以保留 status/score，但不返回 details/output
  const mine = await apiGet(
    `/api/v1/submissions/${contestSubmissionId}`,
    participantToken,
  );
  if (mine.status !== 200) {
    throw new Error(`参赛者本人查看竞赛详情应 200，实际 ${mine.status}`);
  }
  const mineData = (mine.body as { data: Record<string, unknown> }).data;
  if (
    "details" in mineData || "output" in mineData || "subtasks" in mineData ||
    "testCases" in mineData
  ) {
    throw new Error(`参赛者本人赛中详情泄露判据: ${JSON.stringify(mineData)}`);
  }
});

e2eTest(
  "[e2e/anti-cheat] 7. 私有套卷练习提交非 owner 被拒，owner 响应不泄 expected",
  async () => {
    if (!isE2E) return;
    // 攻击者对 private 套卷做练习提交应 403（防止把练习当答案 oracle）
    const submit = await apiPost(
      `${paperPath()}/objective-submissions`,
      {
        answers: { [privateQuestionId]: ["A"] },
        version_id: privateVersionId,
      },
      attackerToken,
    );
    if (submit.status !== 404) {
      throw new Error(
        `私有套卷练习提交应 404，实际 ${submit.status} ${
          JSON.stringify(submit.body)
        }`,
      );
    }

    // owner 本人可练习提交；即使私有卷也不返回 expected（F-14 写入已剥离）
    const ownerSubmit = await apiPost(
      `${paperPath()}/objective-submissions`,
      {
        answers: { [privateQuestionId]: ["A"] },
        version_id: privateVersionId,
      },
      ownerToken,
    );
    if (ownerSubmit.status !== 201) {
      throw new Error(
        `owner 私有套卷练习提交失败: ${ownerSubmit.status} ${
          JSON.stringify(ownerSubmit.body)
        }`,
      );
    }
    const submitted = (ownerSubmit.body as {
      data: {
        submission_id: string;
        details: Record<string, { expected?: unknown; explanation?: unknown }>;
      };
    }).data;
    if (JSON.stringify(submitted).includes("expected")) {
      throw new Error("练习提交响应 JSON 含 expected 字段");
    }

    // owner 详情同样不泄 expected
    const detail = await apiGet(
      `/api/v1/domains/${privateDomain}/objective-submissions/${submitted.submission_id}`,
      ownerToken,
    );
    if (detail.status !== 200) {
      throw new Error(
        `客观题提交详情应 200，实际 ${detail.status}`,
      );
    }
    const detailEntry2 = (detail.body as {
      data: {
        details: Record<string, { expected?: unknown; explanation?: unknown }>;
      };
    }).data.details?.[privateQuestionId];
    if (detailEntry2?.expected !== undefined) {
      throw new Error(
        `详情不应含 expected: ${JSON.stringify(detailEntry2)}`,
      );
    }
  },
);
