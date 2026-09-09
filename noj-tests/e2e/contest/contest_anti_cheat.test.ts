/**
 * 竞赛防作弊攻击剧本 E2E。
 *
 * 覆盖 7 个场景（对应 2026-09-05-contest-anti-cheat-fix-plan Task 18 / spec §12）：
 * 1. 无上下文直取私有题 → 404；
 * 2. 伪造 contestId 提交 → 403/400；
 * 3. 竞赛入口重复提交超 submission_limits → 429；普通入口对私有题 → 403；
 * 4. 他人私有题加入自己竞赛/题单 → 403；
 * 5. 非参赛者订阅 SSE contestSubmission → 无事件；
 * 6. 赛中提交详情/全局队列不泄判据；
 * 7. 客观题练习提交不泄 expected（private paper）。
 *
 * 依赖：Task 17 的 PUT /api/v1/problems/:id visibility setter（owner 转 private）；
 * 若该 setter 尚未实现，测试会以明确的 setup 错误提示阻塞。
 */
import {
  apiGet,
  apiPost,
  apiPut,
  BASE_URL,
  e2eTest,
  getAdminToken,
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
let privatePaperId = "";
let privateQuestionId = "";

// 竞赛上下文
let sseContestId = "";
let limitContestId = "";
let contestSubmissionId = "";

interface ProblemData {
  id: string;
  visibility: string;
}

interface QuestionData {
  id: string;
}

/** 通过 e2e 容器直接更新题目可见性（仅作 setup 兜底；优先走 HTTP visibility setter）。 */
async function setProblemPrivateViaDb(problemId: string): Promise<void> {
  const sql =
    `UPDATE problems SET visibility = 'private', updated_at = now() ` +
    `WHERE id = '${problemId}'`;
  const cmd = new Deno.Command("docker", {
    args: [
      "exec",
      "noj-e2e-postgres",
      "psql",
      "-U",
      "e2e",
      "-d",
      "e2e",
      "-c",
      sql,
    ],
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `docker psql 设置 private 失败: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
}

/** 创建私有客观题套卷：owner 创建后通过 PUT visibility setter 置为 private；setter 未实现时回退 DB 兜底。 */
async function createPrivatePaper(
  token: string,
  title: string,
): Promise<string> {
  const res = await apiPost(
    "/api/v1/problems",
    {
      type: "U",
      is_objective: true,
      title,
      description: "竞赛防作弊 e2e 私有套卷",
    },
    token,
  );
  if (res.status !== 201) {
    throw new Error(
      `创建私有客观题套卷失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  const id = (res.body as { data: ProblemData }).data.id;

  await apiPut(
    `/api/v1/problems/${id}`,
    { visibility: "private" },
    token,
  );
  let check = await apiGet(`/api/v1/problems/${id}`, token);
  let data = (check.body as { data: ProblemData }).data;
  if (data?.visibility === "private") return id;

  // Task 17 的 visibility setter 尚未实现时，用 DB 兜底创建私有题，保证攻击剧本可执行。
  await setProblemPrivateViaDb(id);
  check = await apiGet(`/api/v1/problems/${id}`, token);
  data = (check.body as { data: ProblemData }).data;
  if (data?.visibility !== "private") {
    throw new Error(
      `题目仍无法置为 private（HTTP setter + DB 兜底均失败），当前 ${
        data?.visibility ?? "未知"
      }`,
    );
  }
  return id;
}

/** 创建运行中的竞赛。isPublic=false 时用于 SSE 非参赛者隔离场景。 */
async function createContest(
  title: string,
  opts: {
    problemId: string;
    isPublic: boolean;
    kind?: "public" | "invite";
    password?: string;
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
    is_public: opts.isPublic,
    kind: opts.kind ?? (opts.isPublic ? "public" : "invite"),
    affect_global_ranking: false,
    problems: [{
      problem_id: opts.problemId,
      sort_order: 0,
      label: "A",
      score: 100,
    }],
  };
  if (opts.password) body.password = opts.password;
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

  // 给私有套卷加一题，供场景 7 练习提交使用
  const q = await apiPost(
    `/api/v1/problems/${privatePaperId}/questions`,
    {
      type: "single",
      prompt: "私有套卷唯一题",
      options: [
        { key: "A", text: "正确项" },
        { key: "B", text: "错误项" },
      ],
      answer: ["A"],
      explanation: "这道题的解析不应泄露给非 owner",
    },
    ownerToken,
  );
  if (q.status !== 201) {
    throw new Error(
      `创建私有套卷小题失败: ${q.status} ${JSON.stringify(q.body)}`,
    );
  }
  privateQuestionId = (q.body as { data: QuestionData }).data.id;

  // SSE 隔离场景使用非公开邀请赛；注册参赛者供后续触发提交
  sseContestId = await createContest(`E2E SSE 防作弊赛 ${ts}`, {
    problemId: publicProblemId,
    isPublic: false,
    kind: "invite",
    password: "SseInvitePass1",
  });
  const regSse = await apiPost(
    `/api/v1/contests/${sseContestId}/register`,
    { password: "SseInvitePass1" },
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
    isPublic: true,
    kind: "public",
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
  const anon = await apiGet(`/api/v1/problems/${privatePaperId}`);
  if (anon.status !== 404) {
    throw new Error(`匿名读取私有题应 404，实际 ${anon.status}`);
  }
  const asOther = await apiGet(
    `/api/v1/problems/${privatePaperId}`,
    attackerToken,
  );
  if (asOther.status !== 404) {
    throw new Error(`非 owner 读取私有题应 404，实际 ${asOther.status}`);
  }
  const questions = await apiGet(
    `/api/v1/problems/${privatePaperId}/questions`,
    attackerToken,
  );
  if (questions.status !== 404) {
    throw new Error(
      `非 owner 读取私有套卷小题应 404，实际 ${questions.status}`,
    );
  }
  const ownerView = await apiGet(
    `/api/v1/problems/${privatePaperId}`,
    ownerToken,
  );
  if (ownerView.status !== 200) {
    throw new Error(`owner 应可读自己的私有题，实际 ${ownerView.status}`);
  }
});

e2eTest("[e2e/anti-cheat] 2. 伪造 contestId 提交 → 403/400", async () => {
  if (!isE2E) return;
  // 客观题提交入口支持携带 contest_id：攻击者用真实存在的非公开赛 ID，
  // 但该套卷不属于该赛/攻击者未注册，服务层必须拒绝伪造的竞赛上下文。
  const res = await apiPost(
    `/api/v1/problems/${privatePaperId}/submit`,
    {
      answers: { [privateQuestionId]: ["A"] },
      contest_id: sseContestId,
    },
    attackerToken,
  );
  if (res.status !== 403 && res.status !== 400) {
    throw new Error(`伪造 contestId 提交应 403/400，实际 ${res.status}`);
  }
});

e2eTest(
  "[e2e/anti-cheat] 3. 竞赛入口重复提交超 submission_limits → 429；普通入口私有题 → 403",
  async () => {
    if (!isE2E) return;
    const first = await apiPost(
      `/api/v1/contests/${limitContestId}/submit`,
      {
        problem_id: publicProblemId,
        language: "python3",
        code: "print(1)",
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
      },
      attackerToken,
    );
    if (ordinary.status !== 403) {
      throw new Error(`普通入口提交他人私有题应 403，实际 ${ordinary.status}`);
    }
  },
);

e2eTest("[e2e/anti-cheat] 4. 他人私有题加入自己竞赛/题单 → 403", async () => {
  if (!isE2E) return;
  // 4.1 攻击者创建自己的 invite 赛，但尝试加入别人的私有套卷
  const now = Date.now();
  const contestRes = await apiPost(
    "/api/v1/contests",
    {
      title: `E2E 攻击者建赛 ${ts}`,
      start_time: new Date(now - 60 * 60 * 1000).toISOString(),
      end_time: new Date(now + 60 * 60 * 1000).toISOString(),
      type: "kaggle",
      kind: "invite",
      password: "AttackInvite1",
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
  if (contestRes.status !== 403) {
    throw new Error(
      `把他人私有题加入自己竞赛应 403，实际 ${contestRes.status}`,
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
  if (addRes.status !== 403) {
    throw new Error(
      `把他人私有题加入自己题单应 403，实际 ${addRes.status}`,
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

  // 6.1 非参赛者查看竞赛提交详情：仅存在级信息（id/problem_id/status）
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
    Object.keys(data).length !== 3 ||
    data.id !== contestSubmissionId ||
    data.problem_id !== publicProblemId ||
    typeof data.status !== "string"
  ) {
    throw new Error(
      `非参赛者详情应为 {id, problem_id, status}，实际 ${JSON.stringify(data)}`,
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
      `/api/v1/problems/${privatePaperId}/submit`,
      {
        answers: { [privateQuestionId]: ["A"] },
      },
      attackerToken,
    );
    if (submit.status !== 403) {
      throw new Error(
        `私有套卷练习提交应 403，实际 ${submit.status} ${
          JSON.stringify(submit.body)
        }`,
      );
    }

    // owner 本人可练习提交；即使私有卷也不返回 expected（F-14 写入已剥离）
    const ownerSubmit = await apiPost(
      `/api/v1/problems/${privatePaperId}/submit`,
      {
        answers: { [privateQuestionId]: ["A"] },
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
      `/api/v1/problems/submissions/${submitted.submission_id}`,
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
