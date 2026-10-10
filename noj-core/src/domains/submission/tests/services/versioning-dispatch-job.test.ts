/**
 * 批量任务条目派发测试（Handbook §5.7、边界表）。
 *
 * 覆盖：按目标版本内容构造任务（run_id = 新尝试 id）、序列递增、目标版本语言不接受
 * → failed + LANGUAGE_NOT_SUPPORTED、源已删除 → skipped + SOURCE_DELETED、
 * 未知历史版本 → skipped + LEGACY_VERSION_UNKNOWN、源正在评测 → skipped +
 * SOURCE_JUDGING、客观题条目按快照重判并写入尝试与投影。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import { acceptRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

const now = new Date().toISOString();
const ts = Date.now();

await resetDbForTest();
const db = getDb();

const dualConfig = (timeLimitMs: number) => ({
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: timeLimitMs,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
});

const oiConfig = (languages: string[]) => ({
  backend: "native" as const,
  languages,
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "default" as const },
  subtasks: [{
    id: "all",
    score: 100,
    cases: [{ input: "1.in", output: "1.out" }],
  }],
});

/** 建用户；返回 id。 */
async function makeUser(tag: string): Promise<string> {
  const id = `tst-dispatch-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `tst-dispatch-${tag}-${ts}`,
    email: `tst-dispatch-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 建题 + 两个版本（V1/V2），返回 {problemId, v1, v2}。 */
async function seedProblemWithVersions(
  tag: string,
  v1Content: Record<string, unknown>,
  v2Content: Record<string, unknown>,
  projectionConfig: Record<string, unknown>,
): Promise<{ problemId: string; v1: string; v2: string }> {
  const problemId = `tst-dispatch-prob-${tag}-${ts}`;
  const v1 = `tst-dispatch-v1-${tag}-${ts}`;
  const v2 = `tst-dispatch-v2-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `派发测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 97000 + Math.floor(Math.random() * 2000),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: projectionConfig,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values([
    {
      id: v1,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: v1Content,
      published_at: now,
    },
    {
      id: v2,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: v2Content,
      published_at: now,
    },
  ]);
  // 复合外键：版本行必须先存在，再挂最新版指针
  await db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  return { problemId, v1, v2 };
}

/** 建提交 + 初次尝试（sequence 0）。 */
async function seedSubmission(
  problemId: string,
  userId: string,
  versionId: string,
  extra: Record<string, unknown> = {},
): Promise<{ submissionId: string; attemptId: string }> {
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
    ...extra,
  });
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: problemId,
    problem_version_id: versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    created_at: now,
  });
  return { submissionId, attemptId };
}

/** 受理 latest 目标的重测任务。 */
async function acceptLatestJob(
  actorId: string,
  items: Array<{ kind: "submission" | "objective"; id: string }>,
): Promise<string> {
  const accepted = await acceptRejudgeJob(
    actorId,
    {
      kind: "rejudge",
      scope: { type: "selected", submissions: items },
      target: { mode: "latest" },
    },
    `idem-${crypto.randomUUID()}`,
  );
  return accepted.job_id;
}

/** 在假 Redis 环境里领取并派发全部条目。 */
async function dispatchAll(
  jobId: string,
): Promise<{ messages: Record<string, unknown>[]; outcomes: string[] }> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    const redis = getRedis();
    await redis.connect();

    // 只领取本任务条目（同一测试文件内的其他任务条目不受影响）
    const items = (await claimJobItems("worker-1", { limit: 100 }))
      .filter((item) => item.job_id === jobId);
    const outcomes: string[] = [];
    for (const item of items) {
      outcomes.push(await dispatchJobItem(item, "worker-1", "rejudge"));
    }
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:high",
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:ai:low",
        "noj:judge:queue:oi-native:medium",
        "noj:judge:queue:oi-wasm:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) messages.push(JSON.parse(raw));
    }
    return { messages, outcomes };
  } finally {
    await fake.stop();
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

/** 读取条目终态。 */
async function loadItem(jobId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  );
  return item;
}

Deno.test({
  name: "dispatch: latest 目标按目标版本内容构造任务且 run_id = 新尝试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("ok");
    const { problemId, v1, v2 } = await seedProblemWithVersions(
      "ok",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(9999),
    );
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const jobId = await acceptLatestJob(actor, [{
      kind: "submission",
      id: submissionId,
    }]);

    const { messages, outcomes } = await dispatchAll(jobId);
    assertEquals(outcomes, ["dispatched"]);

    const item = await loadItem(jobId);
    assertEquals(item.status, "dispatched");
    assertEquals(item.target_version_id, v2);

    const task = messages.find((m) => m.submission_id === submissionId);
    assertEquals(task !== undefined, true);
    assertEquals(task!.run_id, item.attempt_id);
    assertEquals(task!.problem_version_id, v2);
    // 配置来自 V2（2222），不是题目投影（9999）
    const runtime = task!.runtime_config as {
      evaluator: { time_limit_ms: number };
    };
    assertEquals(runtime.evaluator.time_limit_ms, 2222);

    // 新尝试：sequence 递增、source=rejudge、绑定目标版本
    const [attempt] = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, item.attempt_id as string),
    );
    assertEquals(attempt.sequence, 1);
    assertEquals(attempt.source, "rejudge");
    assertEquals(attempt.problem_version_id, v2);
    assertEquals(attempt.state, "queued");
  },
});

Deno.test({
  name: "dispatch: 目标版本不接受原语言 → failed + LANGUAGE_NOT_SUPPORTED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("lang");
    const { problemId, v1 } = await seedProblemWithVersions(
      "lang",
      {
        kind: "oi",
        title: "V1",
        description: "d",
        samples: [],
        runtime_config: oiConfig(["c", "cc"]),
      },
      {
        kind: "oi",
        title: "V2",
        description: "d",
        samples: [],
        runtime_config: oiConfig(["c"]),
      },
      oiConfig(["c", "cc"]),
    );
    const { submissionId } = await seedSubmission(problemId, actor, v1, {
      language: "cc",
      code: "int main(){}",
    });
    const jobId = await acceptLatestJob(actor, [{
      kind: "submission",
      id: submissionId,
    }]);

    const { messages, outcomes } = await dispatchAll(jobId);
    assertEquals(outcomes, ["failed"]);
    const item = await loadItem(jobId);
    assertEquals(item.status, "failed");
    assertEquals(item.reason_code, "LANGUAGE_NOT_SUPPORTED");
    assertEquals(item.attempt_id, null);
    assertEquals(messages.length, 0);
  },
});

Deno.test({
  name: "dispatch: 源提交已删除 → skipped + SOURCE_DELETED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("deleted");
    const { problemId, v1 } = await seedProblemWithVersions(
      "deleted",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(1111),
    );
    const { submissionId, attemptId } = await seedSubmission(
      problemId,
      actor,
      v1,
    );
    const jobId = await acceptLatestJob(actor, [{
      kind: "submission",
      id: submissionId,
    }]);
    // 受理后删除源提交（条目保留原始引用以便解释）
    await db.delete(evaluationAttempts).where(
      eq(evaluationAttempts.id, attemptId),
    );
    await db.delete(submissions).where(eq(submissions.id, submissionId));

    const { outcomes } = await dispatchAll(jobId);
    assertEquals(outcomes, ["skipped"]);
    const item = await loadItem(jobId);
    assertEquals(item.status, "skipped");
    assertEquals(item.reason_code, "SOURCE_DELETED");
  },
});

Deno.test({
  name: "dispatch: 未知历史版本 → skipped + LEGACY_VERSION_UNKNOWN",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("legacy");
    const { problemId, v1, v2 } = await seedProblemWithVersions(
      "legacy",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(1111),
    );
    // 存量提交：无提交时版本（legacy_unknown）
    const submissionId = crypto.randomUUID();
    await db.insert(submissions).values({
      id: submissionId,
      user_id: actor,
      problem_id: problemId,
      status: "finished",
      language: "python3",
      code: "print(1)",
      submitted_version_id: null,
      version_origin: "legacy_unknown",
      created_at: now,
    });
    const jobId = await acceptLatestJob(actor, [{
      kind: "submission",
      id: submissionId,
    }]);

    // `submitted` 目标下未知历史版本在**受理阶段**就应被固定为无法重测：
    // 条目要么当场 skipped，要么带空目标版本等待 worker 判定。两条路径都必须
    // 得到同一个机器可读原因码，且绝不产生任务。
    const submitted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
      `idem-submitted-${crypto.randomUUID()}`,
    );
    const { outcomes, messages } = await dispatchAll(submitted.job_id);
    const item = await loadItem(submitted.job_id);
    if (item.status === "skipped") {
      assertEquals(item.reason_code, "LEGACY_VERSION_UNKNOWN");
      assertEquals(outcomes.length, 0);
    } else {
      assertEquals(outcomes, ["skipped"]);
      assertEquals(item.reason_code, "LEGACY_VERSION_UNKNOWN");
    }
    assertEquals(messages.length, 0, "未知历史版本不得产生任何评测任务");
    void jobId;
    void v1;
    void v2;
  },
});

Deno.test({
  name: "dispatch: 源正在评测 → skipped + SOURCE_JUDGING",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("judging");
    const { problemId, v1, v2 } = await seedProblemWithVersions(
      "judging",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(1111),
    );
    const { submissionId, attemptId } = await seedSubmission(
      problemId,
      actor,
      v1,
    );
    const jobId = await acceptLatestJob(actor, [{
      kind: "submission",
      id: submissionId,
    }]);
    // 在途执行：active_attempt_id 指向初次尝试
    await db.update(submissions).set({
      active_attempt_id: attemptId,
      status: "judging",
    }).where(eq(submissions.id, submissionId));

    const { outcomes } = await dispatchAll(jobId);
    assertEquals(outcomes, ["skipped"]);
    const item = await loadItem(jobId);
    assertEquals(item.reason_code, "SOURCE_JUDGING");
    void v2;
  },
});

Deno.test({
  name: "dispatch: 客观题条目按目标版本快照重判并写入尝试与投影",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("objective");
    const problemId = `tst-dispatch-obj-${ts}`;
    const v1 = `tst-dispatch-obj-v1-${ts}`;
    const v2 = `tst-dispatch-obj-v2-${ts}`;
    const question = (answer: string, explanation = "") => ({
      key: "q-1",
      sort_order: 0,
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: [answer],
      explanation,
    });
    await db.insert(problems).values({
      id: problemId,
      title: "客观题派发题",
      description: "d",
      difficulty: "easy",
      type: "P",
      number: 99000 + Math.floor(Math.random() * 500),
      owner_id: "0",
      is_objective: true,
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values([
      {
        id: v1,
        problem_id: problemId,
        version: 1,
        origin: "published",
        content: {
          kind: "objective",
          title: "V1",
          description: "d",
          samples: [],
          questions: [question("A", "V1 解析")],
        },
        published_at: now,
      },
      {
        id: v2,
        problem_id: problemId,
        version: 2,
        origin: "published",
        content: {
          kind: "objective",
          title: "V2",
          description: "d",
          samples: [],
          questions: [question("B", "V2 解析")],
        },
        published_at: now,
      },
    ]);
    await db.update(problems).set({ latest_version_id: v2 }).where(
      eq(problems.id, problemId),
    );

    const submissionId = crypto.randomUUID();
    const initialAttemptId = crypto.randomUUID();
    await db.insert(objectiveSubmissions).values({
      id: submissionId,
      paper_id: problemId,
      user_id: actor,
      submission_type: "practice",
      answers: { "q-1": ["A"] },
      status: "finished",
      score: 10000,
      details: {},
      submitted_version_id: v1,
      version_origin: "known",
      created_at: now,
    });
    // 指针列 → evaluation_attempts（循环外键）：提交行先建，尝试再建，
    // 最后回填指针（与写入服务的实际顺序一致）
    await db.insert(evaluationAttempts).values({
      id: initialAttemptId,
      objective_submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: v1,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 10000,
      accepted: true,
      created_at: now,
      finished_at: now,
    });
    await db.update(objectiveSubmissions).set({
      is_valid: true,
      is_accepted: true,
      effective_attempt_id: initialAttemptId,
      accepted_attempt_id: initialAttemptId,
      latest_attempt_id: initialAttemptId,
    }).where(eq(objectiveSubmissions.id, submissionId));
    await db.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      objective_submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: v1,
      current_attempt_id: initialAttemptId,
      updated_at: now,
    });

    const jobId = await acceptLatestJob(actor, [{
      kind: "objective",
      id: submissionId,
    }]);
    const { outcomes } = await dispatchAll(jobId);
    assertEquals(outcomes, ["dispatched"]);

    const item = await loadItem(jobId);
    assertEquals(item.status, "succeeded");
    assertEquals(item.attempt_id !== null, true);

    // 新尝试按 V2 判卷：答案是 A 而 V2 要求 B → 0 分，且原 answers 未被改写
    const [attempt] = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, item.attempt_id as string),
    );
    assertEquals(attempt.problem_version_id, v2);
    assertEquals(attempt.source, "rejudge");
    assertEquals(attempt.score, 0);
    assertEquals(attempt.accepted, false);

    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, submissionId),
    );
    assertEquals(row.answers, { "q-1": ["A"] });
    // 跨版本保留（Handbook §1.3）：V1 满分 + V2 零分在 `any` 下都算候选 →
    // 有效成绩取最高分（V1 满分），通过指针仍是 V1 的初次尝试
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, true);
    assertEquals(row.effective_attempt_id, initialAttemptId);
    assertEquals(row.accepted_attempt_id, initialAttemptId);
    assertEquals(row.latest_attempt_id, item.attempt_id);
  },
});

/** 受理升级任务（practice 上下文）。 */
async function acceptUpgrade(
  actorId: string,
  items: Array<{ kind: "submission" | "objective"; id: string }>,
  context: "practice" | "source_contest" = "practice",
): Promise<string> {
  const { acceptUpgradeJob } = await import(
    "../../services/versioning/upgrade-jobs.ts"
  );
  const accepted = await acceptUpgradeJob(
    actorId,
    { submissions: items, context },
    `idem-upgrade-${crypto.randomUUID()}`,
  );
  return accepted.job_id;
}

/** 在假 Redis 环境里领取并派发某升级任务的条目。 */
async function dispatchUpgradeJob(
  jobId: string,
): Promise<{ messages: Record<string, unknown>[]; outcomes: string[] }> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    const redis = getRedis();
    await redis.connect();
    const items = (await claimJobItems("worker-up", { limit: 100 }))
      .filter((item) => item.job_id === jobId);
    const outcomes: string[] = [];
    for (const item of items) {
      outcomes.push(await dispatchJobItem(item, "worker-up", "upgrade"));
    }
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:ai:low",
        "noj:judge:queue:oi-native:medium",
        "noj:judge:queue:oi-wasm:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) messages.push(JSON.parse(raw));
    }
    return { messages, outcomes };
  } finally {
    await fake.stop();
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

Deno.test({
  name: "dispatch: 代码升级创建新提交并派发（原提交不动）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("up-code");
    const { problemId, v1, v2 } = await seedProblemWithVersions(
      "up-code",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(1111),
    );
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const jobId = await acceptUpgrade(actor, [{
      kind: "submission",
      id: submissionId,
    }]);

    const { messages, outcomes } = await dispatchUpgradeJob(jobId);
    assertEquals(outcomes, ["dispatched"]);

    const item = await loadItem(jobId);
    assertEquals(item.status, "dispatched");
    const newId = item.result_submission_id as string;
    assertEquals(typeof newId, "string");
    assertEquals(newId !== submissionId, true);

    const [created] = await db.select().from(submissions).where(
      eq(submissions.id, newId),
    );
    assertEquals(created.upgraded_from_id, submissionId);
    assertEquals(created.submitted_version_id, v2);
    assertEquals(created.version_origin, "known");
    assertEquals(created.contest_id, null);
    assertEquals(created.status, "judging");
    assertEquals(created.code, "print(1)");

    // 原提交保持原样（版本、状态、判定都不动）
    const [original] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(original.submitted_version_id, v1);
    assertEquals(original.status, "finished");
    assertEquals(original.upgraded_from_id, null);

    // 任务是针对**新提交**的，run_id 指向新提交的新尝试
    const task = messages.find((m) => m.submission_id === newId);
    assertEquals(task !== undefined, true);
    assertEquals(task!.run_id, item.attempt_id);
    assertEquals(task!.problem_version_id, v2);
    const [attempt] = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, item.attempt_id as string),
    );
    assertEquals(attempt.submission_id, newId);
    assertEquals(attempt.source, "upgrade");
    assertEquals(attempt.sequence, 0);
  },
});

Deno.test({
  name: "dispatch: 原提交已在目标版本 → skipped + ALREADY_LATEST",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("up-latest");
    const { problemId, v1, v2 } = await seedProblemWithVersions(
      "up-latest",
      {
        kind: "ai",
        title: "V1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(1111),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      {
        kind: "ai",
        title: "V2",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig(2222),
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      dualConfig(1111),
    );
    // 直接以 V2 提交（= 最新版）后升级 → 受理侧本来就会跳过；这里验证派发侧兜底
    const { submissionId } = await seedSubmission(problemId, actor, v2);
    const jobId = await acceptUpgrade(actor, [{
      kind: "submission",
      id: submissionId,
    }]);
    const { messages } = await dispatchUpgradeJob(jobId);
    const item = await loadItem(jobId);
    if (item.status === "skipped") {
      assertEquals(item.reason_code, "ALREADY_LATEST");
    } else {
      // 受理侧未跳过时，派发侧必须给出同一原因码
      assertEquals(item.reason_code, "ALREADY_LATEST");
    }
    assertEquals(messages.length, 0);
    assertEquals(item.result_submission_id, null);
    void v1;
  },
});

Deno.test({
  name: "dispatch: 客观题升级落练习提交并按目标版本重判",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("up-obj");
    const problemId = `tst-dispatch-upobj-${ts}`;
    const v1 = `tst-dispatch-upobj-v1-${ts}`;
    const v2 = `tst-dispatch-upobj-v2-${ts}`;
    const contestId = `tst-dispatch-upobj-contest-${ts}`;
    const question = (answer: string) => ({
      key: "q-1",
      sort_order: 0,
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: [answer],
      explanation: "",
    });
    await db.insert(problems).values({
      id: problemId,
      title: "客观题升级题",
      description: "d",
      difficulty: "easy",
      type: "P",
      number: 99500 + Math.floor(Math.random() * 400),
      owner_id: "0",
      is_objective: true,
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values([
      {
        id: v1,
        problem_id: problemId,
        version: 1,
        origin: "published",
        content: {
          kind: "objective",
          title: "V1",
          description: "d",
          samples: [],
          questions: [question("A")],
        },
        published_at: now,
      },
      {
        id: v2,
        problem_id: problemId,
        version: 2,
        origin: "published",
        content: {
          kind: "objective",
          title: "V2",
          description: "d",
          samples: [],
          questions: [question("A"), { ...question("B"), key: "q-2" }],
        },
        published_at: now,
      },
    ]);
    await db.update(problems).set({ latest_version_id: v2 }).where(
      eq(problems.id, problemId),
    );
    await db.insert(contests).values({
      id: contestId,
      title: `客观题升级竞赛 ${ts}`,
      description: "",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      type: "kaggle",
      config: {},
      created_at: now,
      updated_at: now,
    });

    const sourceId = crypto.randomUUID();
    await db.insert(objectiveSubmissions).values({
      id: sourceId,
      paper_id: problemId,
      user_id: actor,
      contest_id: contestId,
      submission_type: "contest",
      answers: { "q-1": ["A"] },
      status: "finished",
      score: 10000,
      details: {},
      submitted_version_id: v1,
      version_origin: "known",
      created_at: now,
    });

    const jobId = await acceptUpgrade(actor, [{
      kind: "objective",
      id: sourceId,
    }]);
    const { outcomes } = await dispatchUpgradeJob(jobId);
    assertEquals(outcomes, ["dispatched"]);

    const item = await loadItem(jobId);
    assertEquals(item.status, "succeeded");
    const newId = item.result_submission_id as string;
    assertEquals(typeof newId, "string");

    const [created] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, newId),
    );
    // 竞赛提交升级后落练习提交（竞赛一次性提交限制不适用于升级）
    assertEquals(created.contest_id, null);
    assertEquals(created.submission_type, "practice");
    assertEquals(created.upgraded_from_id, sourceId);
    assertEquals(created.submitted_version_id, v2);
    assertEquals(created.answers, { "q-1": ["A"] });

    // 新提交按 V2 判卷：只有 1/2 题正确 → 5000，且有效但未通过（满分口径）
    assertEquals(created.score, 5000);
    assertEquals(created.is_valid, true);
    assertEquals(created.is_accepted, false);

    // 原竞赛提交不动
    const [original] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, sourceId),
    );
    assertEquals(original.contest_id, contestId);
    assertEquals(original.submission_type, "contest");
    assertEquals(original.score, 10000);
  },
});
