/**
 * 正式提交平台错误自动重试（最多 3 次，次数持久化在尝试快照）。
 *
 * 覆盖：
 * - platform_error 后自动创建新尝试（sequence 递增），提交保持 pending 不闪 error；
 * - 连续第 3 次自动重试仍失败才把提交定为 error；
 * - graded（含 0 分）一律不重试；
 * - 只重试偶发错误：选手缺函数、LLM 额度/计费/鉴权与未知错误不重试；
 * - 重复回调不会重复创建尝试，也不会重复派发；
 * - 重测任务条目在重试结束前保持未完成，耗尽后才 failed。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissionJobItems,
  submissions,
} from "../../../../shared/db/schema.ts";
import { createSubmission } from "../../index.ts";
import {
  classifyPlatformErrorRetry,
  readAutoRetryMarker,
  resolvePlatformErrorMaxRetries,
} from "../../services/versioning/auto-retry.ts";
import { createAttempt } from "../../services/versioning/attempts.ts";
import { acceptRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";
import { handleResultMessage } from "../../mq/consumer.ts";
import { ALL_JUDGE_QUEUES } from "../../mq/producer.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  authorizeLegacyJobActorForTest,
  bindMainProblemForTest,
  saveV2ResultForTest,
  v2ResultForTest,
} from "../_versioning-fixtures.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import { DEFAULT_DOMAIN_ID } from "../../../workspace/index.ts";

const now = new Date().toISOString();

const runtimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

async function seedProblem(problemId: string, number: number): Promise<void> {
  await authorizeLegacyJobActorForTest();
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    domain_id: DEFAULT_DOMAIN_ID,
    visibility: "public",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    runtime_config: runtimeConfig,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: `${problemId}-v1`,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content: {
      kind: "ai",
      title: problemId,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: runtimeConfig,
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: `${problemId}-v1` })
    .where(eq(problems.id, problemId));
  await bindMainProblemForTest(problemId);
}

/** 建一次提交（评测队列不可用会抛错，但提交与初次尝试已落库）。 */
async function submit(problemId: string): Promise<string> {
  await createSubmission("0", {
    problem_id: problemId,
    language: "python",
    code: "print(1)",
    version_id: `${problemId}-v1`,
  }).catch(() => {/* 评测队列不可用属预期 */});
  const rows = await getDb().select().from(submissions).where(
    eq(submissions.problem_id, problemId),
  );
  return rows[rows.length - 1].id;
}

/** judge 回传一次平台错误（绑定提交当前活动尝试）。 */
async function reportPlatformError(submissionId: string) {
  return await saveV2ResultForTest({
    submission_id: submissionId,
    status: "error",
    score: 0,
    output: "LLM gateway 连接失败: Remote end closed connection",
    details: {},
    result_kind: "platform_error",
  });
}

async function loadSubmission(id: string) {
  const [row] = await getDb().select().from(submissions).where(
    eq(submissions.id, id),
  );
  return row;
}

async function loadAttempts(submissionId: string) {
  const rows = await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.submission_id, submissionId),
  );
  return rows.sort((a, b) => a.sequence - b.sequence);
}

Deno.test("auto-retry: 默认上限为 3 次", () => {
  assertEquals(resolvePlatformErrorMaxRetries(), 3);
});

Deno.test("auto-retry: platform_error 后自动创建新尝试，提交保持 pending", async () => {
  await seedProblem("ar-p1", 994001);
  const submissionId = await submit("ar-p1");
  const [initial] = await loadAttempts(submissionId);

  const outcome = await reportPlatformError(submissionId);
  assertEquals(outcome.applied, true);
  assertEquals(outcome.attempt_applied, "platform_error");
  assertEquals(outcome.auto_retry?.retry_count, 1);
  assertEquals(outcome.auto_retry?.via_job, false);

  const attempts = await loadAttempts(submissionId);
  assertEquals(attempts.length, 2);
  // 失败尝试保留 error 终态（持久化的次数依据），新尝试 sequence 递增
  assertEquals(attempts[0].id, initial.id);
  assertEquals(attempts[0].state, "error");
  assertEquals(attempts[0].result_kind, "platform_error");
  assertEquals(attempts[1].id, outcome.auto_retry?.attempt_id);
  assertEquals(attempts[1].sequence, 1);
  assertEquals(attempts[1].state, "queued");
  assertEquals(attempts[1].problem_version_id, "ar-p1-v1");
  const marker = readAutoRetryMarker(attempts[1].task_snapshot);
  assertEquals(marker?.count, 1);
  assertEquals(marker?.retry_of, initial.id);
  assertEquals(marker?.origin_source, "initial");
  // 冻结执行快照原样沿用
  assertEquals(
    (attempts[1].task_snapshot as Record<string, unknown>).runtime_config,
    (attempts[0].task_snapshot as Record<string, unknown>).runtime_config,
  );

  const row = await loadSubmission(submissionId);
  assertEquals(row.status, "pending");
  assertEquals(row.active_attempt_id, attempts[1].id);
  assertEquals(row.judge_run_id, attempts[1].id);
  assertEquals(row.rejudge_seq, 1);
  assertEquals(row.judge_finished_at, null);
});

Deno.test("auto-retry: 第 3 次重试仍失败才定为 error", async () => {
  await seedProblem("ar-p2", 994002);
  const submissionId = await submit("ar-p2");

  for (let retry = 1; retry <= 3; retry++) {
    const outcome = await reportPlatformError(submissionId);
    assertEquals(outcome.auto_retry?.retry_count, retry);
    assertEquals((await loadSubmission(submissionId)).status, "pending");
  }

  // 初次 + 3 次自动重试全部平台错误 → 不再重试，提交定为 error
  const final = await reportPlatformError(submissionId);
  assertEquals(final.applied, true);
  assertEquals(final.attempt_applied, "platform_error");
  assertEquals(final.auto_retry ?? null, null);

  const attempts = await loadAttempts(submissionId);
  assertEquals(attempts.length, 4);
  assertEquals(attempts.map((a) => a.sequence), [0, 1, 2, 3]);
  assertEquals(attempts.every((a) => a.state === "error"), true);
  const row = await loadSubmission(submissionId);
  assertEquals(row.status, "error");
  assertEquals(row.active_attempt_id, null);
  assertEquals(row.latest_attempt_id, attempts[3].id);
});

Deno.test("auto-retry: 重试后正式判定按正常结果落库", async () => {
  await seedProblem("ar-p3", 994003);
  const submissionId = await submit("ar-p3");
  await reportPlatformError(submissionId);

  const outcome = await saveV2ResultForTest({
    submission_id: submissionId,
    status: "finished",
    score: 10000,
    output: "ok",
    details: {},
  });
  assertEquals(outcome.attempt_applied, "graded");
  assertEquals(outcome.auto_retry ?? null, null);
  // 初次提交的重试结果仍按首次结果计入统计（不当作重测）
  assertEquals(outcome.is_rejudge, false);
  const row = await loadSubmission(submissionId);
  assertEquals(row.status, "finished");
  assertEquals(row.is_accepted, true);
  assertEquals((await loadAttempts(submissionId)).length, 2);
});

Deno.test("auto-retry: graded 0 分不重试", async () => {
  await seedProblem("ar-p4", 994004);
  const submissionId = await submit("ar-p4");

  const outcome = await saveV2ResultForTest({
    submission_id: submissionId,
    status: "finished",
    score: 0,
    output: "wrong",
    details: {},
    result_kind: "graded",
  });
  assertEquals(outcome.attempt_applied, "graded");
  assertEquals(outcome.auto_retry ?? null, null);
  const attempts = await loadAttempts(submissionId);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].state, "finished");
  assertEquals((await loadSubmission(submissionId)).status, "finished");
});

Deno.test("auto-retry: 重复回调不会重复创建尝试", async () => {
  await seedProblem("ar-p5", 994005);
  const submissionId = await submit("ar-p5");
  // 固化同一条结果消息（绑定初次尝试），模拟 at-least-once 重投
  const message = await v2ResultForTest({
    submission_id: submissionId,
    status: "error",
    score: 0,
    output: "Evaluator 总超时",
    details: {},
    result_kind: "platform_error",
  });
  const { saveEvaluationResult } = await import(
    "../../services/submissions/submissions-result.ts"
  );
  const first = await saveEvaluationResult({ ...message });
  assertEquals(first.auto_retry?.retry_count, 1);
  const second = await saveEvaluationResult({ ...message });
  assertEquals(second.applied, false);
  assertEquals((await loadAttempts(submissionId)).length, 2);
  assertEquals(
    (await loadSubmission(submissionId)).active_attempt_id,
    first.auto_retry?.attempt_id,
  );
});

Deno.test({
  name: "auto-retry: 结果消费者即时派发重试，重复消息不重复派发",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await seedProblem("ar-p6", 994006);
    const submissionId = await submit("ar-p6");
    const message = await v2ResultForTest({
      submission_id: submissionId,
      status: "error",
      score: 0,
      output: "系统内部错误 (submission: ar-p6)",
      details: {},
      result_kind: "platform_error",
    });

    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    const readTasks = () =>
      ALL_JUDGE_QUEUES.flatMap((queue) => fake.getMessages(queue)).map((raw) =>
        JSON.parse(raw) as Record<string, unknown>
      ).filter((task) => task.submission_id === submissionId);
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      fake.clear();

      await handleResultMessage({ ...message });
      const attempts = await loadAttempts(submissionId);
      assertEquals(attempts.length, 2);
      const tasks = readTasks();
      assertEquals(tasks.length, 1);
      // 协议 v2：新任务绑定新尝试与递增后的 sequence
      assertEquals(tasks[0].run_id, attempts[1].id);
      assertEquals(tasks[0].attempt_id, attempts[1].id);
      assertEquals(tasks[0].rejudge_seq, 1);
      assertEquals(tasks[0].problem_version_id, "ar-p6-v1");
      // 初次提交的重试沿用初次优先级（非重测的 low）
      assertEquals(tasks[0].priority === "low", false);
      assertEquals((await loadSubmission(submissionId)).status, "judging");

      // 同一条结果重投：幂等忽略，不再派发
      await handleResultMessage({ ...message });
      assertEquals(readTasks().length, 1);
      assertEquals((await loadAttempts(submissionId)).length, 2);
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test("auto-retry: 重测任务条目在重试期间保持未完成，耗尽后才 failed", async () => {
  const db = getDb();
  await seedProblem("ar-p7", 994007);
  const submissionId = await submit("ar-p7");
  // 先有一次正式判定，再受理重测任务
  await saveV2ResultForTest({
    submission_id: submissionId,
    status: "finished",
    score: 10000,
    output: "ok",
    details: {},
  });
  const accepted = await acceptRejudgeJob(
    "0",
    {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: submissionId }],
      },
      target: { mode: "submitted" },
    },
    `ar-job-${Date.now()}`,
  );
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  );
  // 模拟 worker 已派发：创建重测尝试并把条目置为 dispatched
  const rejudge = await createAttempt({
    source: {
      kind: "submission",
      id: submissionId,
      problem_id: "ar-p7",
      contest_id: null,
    },
    problemVersionId: "ar-p7-v1",
    source_kind: "rejudge",
  });
  await db.update(submissionJobItems).set({
    status: "dispatched",
    attempt_id: rejudge.id,
  }).where(eq(submissionJobItems.id, item.id));

  for (let retry = 1; retry <= 3; retry++) {
    const outcome = await reportPlatformError(submissionId);
    assertEquals(outcome.auto_retry?.retry_count, retry);
    assertEquals(outcome.auto_retry?.via_job, true);
    const [current] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, item.id),
    );
    // 条目退回 pending 并改指向新尝试，由 worker 按既有派发路径重派
    assertEquals(current.status, "pending");
    assertEquals(current.attempt_id, outcome.auto_retry?.attempt_id);
    const retryAttempt = (await loadAttempts(submissionId)).at(-1)!;
    assertEquals(
      readAutoRetryMarker(retryAttempt.task_snapshot)?.origin_source,
      "rejudge",
    );
    // 模拟 worker 再次派发
    await db.update(submissionJobItems).set({ status: "dispatched" }).where(
      eq(submissionJobItems.id, item.id),
    );
  }

  const final = await reportPlatformError(submissionId);
  assertEquals(final.auto_retry ?? null, null);
  const [done] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, item.id),
  );
  assertEquals(done.status, "failed");
  assertEquals(done.reason_code, "PLATFORM_ERROR");
  const row = await loadSubmission(submissionId);
  assertEquals(row.status, "error");
  // 平台错误不替换已有正式判定
  assertEquals(row.is_accepted, true);
});

/** 生产 10-15～10-17 platform_error 样例（输出尾部）。 */
const RETRYABLE_SAMPLES: Array<[string, string]> = [
  ["evaluator_total_timeout", "Evaluator 总超时"],
  [
    "judge_internal_error",
    "系统内部错误 (submission: 2de401c3-5d82-4c3b-85c7-488635da7dfa)",
  ],
  [
    "llm_gateway_connection",
    `Traceback (most recent call last):
  File "/workspace/evaluate.py", line 88, in <module>
noj_evaluator_sdk.llm.LLMError: LLM gateway 连接失败: Remote end closed connection without response`,
  ],
  [
    "llm_gateway_connection",
    "noj_evaluator_sdk.llm.LLMError: LLM gateway 连接失败: timed out",
  ],
  [
    "llm_gateway_5xx",
    'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 502: {"error":"upstream_error"}',
  ],
  [
    "llm_gateway_5xx",
    'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 503: {"error":{"code":"provider_unavailable"}}',
  ],
];

const NON_RETRYABLE_SAMPLES: Array<[string, string]> = [
  [
    "function_not_registered",
    `Traceback (most recent call last):
  File "/workspace/evaluate.py", line 41, in <module>
noj_evaluator_sdk.errors.NotFoundError: function 'solve' not registered`,
  ],
  [
    "llm_gateway_4xx",
    'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 402: {"error":"upstream_error"}',
  ],
  [
    "llm_gateway_4xx",
    'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 429: {"error":{"message":"Out of usage for this evaluation","code":"out_of_usage"}}',
  ],
  [
    "llm_gateway_4xx",
    'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 401: {"error":"invalid_token"}',
  ],
  // 缺函数与连接失败同时出现：确定性失败优先，不重试
  [
    "function_not_registered",
    `LLM gateway 连接失败: reset
NotFoundError: function 'solve' not registered`,
  ],
  // 上游计费错误被包成 5xx 时同样不重试
  [
    "llm_payment_required",
    'LLM gateway 返回 502: {"error":"upstream_error","status":402}',
  ],
  ["llm_out_of_usage", '{"code":"out_of_usage"}'],
  ["unknown", "Traceback: ZeroDivisionError: division by zero"],
  ["unknown", ""],
];

Deno.test("auto-retry: 偶发错误命中白名单才重试", () => {
  for (const [reason, output] of RETRYABLE_SAMPLES) {
    assertEquals(
      classifyPlatformErrorRetry({ resultStatus: "error", output }),
      { retryable: true, reason },
      output,
    );
  }
});

Deno.test("auto-retry: 缺函数、额度/计费/鉴权与未知错误不重试", () => {
  for (const [reason, output] of NON_RETRYABLE_SAMPLES) {
    assertEquals(
      classifyPlatformErrorRetry({ resultStatus: "error", output }),
      { retryable: false, reason },
      output,
    );
  }
  // core 判定的非法评分不重试（即使输出含偶发特征）
  assertEquals(
    classifyPlatformErrorRetry({
      resultStatus: "INVALID_SCORE",
      output: "LLM gateway 连接失败",
    }),
    { retryable: false, reason: "invalid_score" },
  );
  // 只看尾部：很早出现、随后被评测器自行处理的连接错误不触发重试
  assertEquals(
    classifyPlatformErrorRetry({
      resultStatus: "error",
      output: "LLM gateway 连接失败\n" + "x".repeat(16 * 1024),
    }).retryable,
    false,
  );
});

Deno.test("auto-retry: 选手缺函数与 LLM 402 直接定为 error，不创建新尝试", async () => {
  await seedProblem("ar-p8", 994008);
  for (
    const output of [
      "noj_evaluator_sdk.errors.NotFoundError: function 'solve' not registered",
      'noj_evaluator_sdk.llm.LLMError: LLM gateway 返回 402: {"error":"upstream_error"}',
    ]
  ) {
    const submissionId = await submit("ar-p8");
    const outcome = await saveV2ResultForTest({
      submission_id: submissionId,
      status: "error",
      score: 0,
      output,
      details: {},
      result_kind: "platform_error",
    });
    assertEquals(outcome.attempt_applied, "platform_error");
    assertEquals(outcome.auto_retry ?? null, null);
    assertEquals((await loadAttempts(submissionId)).length, 1);
    const row = await loadSubmission(submissionId);
    assertEquals(row.status, "error");
    assertEquals(row.active_attempt_id, null);
  }
});
