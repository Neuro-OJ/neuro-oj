/**
 * 版本化评测链路端到端（核心服务层）：提交 → 尝试 → 结果落库（Handbook §5.4、§5.6）。
 *
 * 链路：
 * 1. `createSubmission` 携带版本 → 落库提交（known）+ 创建初次尝试（sequence=0）
 *    并把 `active_attempt_id` 指向它；
 * 2. `saveEvaluationResult`（旧协议，无 attempt_id）用 `active_attempt_id` 兜底解析；
 * 3. 结果终态写入尝试、更新分版本当前判定、按策略重算双口径投影。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  createSubmission,
  EVALUATION_PROTOCOL_VERSION,
  saveEvaluationResult,
} from "../../index.ts";
import { prepareJudgeTask } from "../../services/prepare-judge-task.ts";
import {
  deriveResultKind,
  isAcceptedResult,
} from "../../../../shared/versioning/verdict.ts";

const now = new Date().toISOString();

async function seedProblem(problemId: string, number: number): Promise<void> {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    runtime_config: {
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
    },
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
      runtime_config: {
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
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: `${problemId}-v1` })
    .where(eq(problems.id, problemId));
}

/** 建一次提交（评测队列不可用会抛错，但提交与尝试已落库）。 */
async function submit(
  problemId: string,
  userId = "0",
): Promise<string> {
  await createSubmission(userId, {
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

Deno.test("pipeline: 提交创建初次尝试并指向 active_attempt_id", async () => {
  await seedProblem("ap-p1", 991001);
  const submissionId = await submit("ap-p1");

  const [row] = await getDb().select().from(submissions).where(
    eq(submissions.id, submissionId),
  );
  assertEquals(row.submitted_version_id, "ap-p1-v1");
  assertEquals(row.version_origin, "known");
  assertEquals(row.active_attempt_id !== null, true);

  const attempts = await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.submission_id, submissionId),
  );
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].sequence, 0);
  assertEquals(attempts[0].source, "initial");
  assertEquals(attempts[0].problem_version_id, "ap-p1-v1");
  assertEquals(attempts[0].state, "queued");
  assertEquals(row.active_attempt_id, attempts[0].id);
  // 非敏感快照：不含 token / 下载凭据
  const snapshot = attempts[0].task_snapshot as Record<string, unknown>;
  assertEquals(snapshot.language, "python");
  assertEquals("eval_token" in snapshot, false);
});

Deno.test("pipeline: 旧协议结果经 active_attempt_id 落库并重算投影", async () => {
  const db = getDb();
  await seedProblem("ap-p2", 991002);
  const submissionId = await submit("ap-p2");

  const outcome = await saveEvaluationResult({
    submission_id: submissionId,
    status: "finished",
    score: 10000,
    output: "ok",
    details: { cases: [] },
    time_ms: 120,
    memory_kb: 2048,
  });
  assertEquals(outcome.applied, true);
  assertEquals(outcome.attempt_applied, "graded");

  const attempts = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.submission_id, submissionId),
  );
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].state, "finished");
  assertEquals(attempts[0].result_kind, "graded");
  assertEquals(attempts[0].score, 10000);
  assertEquals(attempts[0].accepted, true);
  assertEquals(attempts[0].finished_at !== null, true);

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, submissionId),
  );
  assertEquals(submission.status, "finished");
  assertEquals(submission.active_attempt_id, null);
  assertEquals(submission.latest_attempt_id, attempts[0].id);
  assertEquals(submission.is_valid, true);
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.effective_attempt_id, attempts[0].id);

  const results = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, submissionId),
  );
  assertEquals(results.length, 1);
  assertEquals(results[0].problem_version_id, "ap-p2-v1");
  assertEquals(results[0].current_attempt_id, attempts[0].id);
});

Deno.test("pipeline: 平台错误结果不替换已有正式判定", async () => {
  const db = getDb();
  await seedProblem("ap-p3", 991003);
  const submissionId = await submit("ap-p3");

  // 第一次正式判定：通过
  await saveEvaluationResult({
    submission_id: submissionId,
    status: "finished",
    score: 10000,
    output: "ok",
    details: {},
  });

  // 人工制造第二次在途尝试（模拟重测/升级），随后回传平台错误
  const { createAttempt } = await import(
    "../../services/versioning/attempts.ts"
  );
  const retry = await createAttempt({
    source: {
      kind: "submission",
      id: submissionId,
      problem_id: "ap-p3",
      contest_id: null,
    },
    problemVersionId: "ap-p3-v1",
    source_kind: "rejudge",
  });
  // 重测入口会把提交重置为 judging（既有状态机只允许 pending/judging/error 落结果）
  await db.update(submissions).set({ status: "judging" }).where(
    eq(submissions.id, submissionId),
  );
  const outcome = await saveEvaluationResult({
    submission_id: submissionId,
    status: "SystemError",
    score: 0,
    output: "支持包缺失",
    details: {},
  });
  assertEquals(outcome.attempt_applied, "platform_error");

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, submissionId),
  );
  // 已有正式判定保留（仍通过），运行状态与最近尝试更新
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.status, "error");
  assertEquals(submission.latest_attempt_id, retry.id);
  assertEquals(submission.active_attempt_id, null);

  const results = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, submissionId),
  );
  assertEquals(results.length, 1);
  const [failedAttempt] = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, retry.id),
  );
  assertEquals(failedAttempt.result_kind, "platform_error");
  // 当前判定仍指向第一次成功的尝试
  assertEquals(results[0].current_attempt_id !== retry.id, true);
});

Deno.test("verdict: 通过语义与既有读取口径一致", () => {
  // 非 finished 一律不通过
  assertEquals(
    isAcceptedResult({ status: "error", score: 10000, details: {} }),
    false,
  );
  // 普通题型：正分即通过
  assertEquals(
    isAcceptedResult({ status: "finished", score: 1, details: {} }),
    true,
  );
  assertEquals(
    isAcceptedResult({ status: "finished", score: 0, details: {} }),
    false,
  );
  // OI：看 verdict，不看分数
  assertEquals(
    isAcceptedResult({
      status: "finished",
      score: 0,
      details: { oi: { verdict: "AC" } },
    }),
    true,
  );
  assertEquals(
    isAcceptedResult({
      status: "finished",
      score: 10000,
      details: { oi: { verdict: "WA" } },
    }),
    false,
  );
  // 平台错误归类：用户侧失败（WA/TLE/MLE/RE/CE）都是 graded
  assertEquals(deriveResultKind("WA"), "graded");
  assertEquals(deriveResultKind("TLE"), "graded");
  assertEquals(deriveResultKind("RuntimeError"), "graded");
  assertEquals(deriveResultKind("finished"), "graded");
  assertEquals(deriveResultKind("SystemError"), "platform_error");
  assertEquals(deriveResultKind("SE"), "platform_error");
  assertEquals(deriveResultKind("error"), "platform_error");
});

Deno.test("pipeline: 任务 run_id 绑定尝试 ID 并携带版本与协议号", () => {
  const dualConfig = {
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
  const base = {
    submission_id: "s-1",
    problem_id: "p-1",
    user_id: "u-1",
    priority: "medium" as const,
    runtime_config: dualConfig,
    language: "python",
    code: "print(1)",
  };

  const task = prepareJudgeTask({
    ...base,
    attempt_id: "att-1",
    problem_version_id: "ver-1",
  });
  assertEquals(task.run_id, "att-1");
  assertEquals(task.problem_version_id, "ver-1");
  assertEquals(
    task.evaluation_protocol_version,
    EVALUATION_PROTOCOL_VERSION,
  );

  // 无尝试的 dual 任务（历史路径）：不下发 run_id，也不谎报版本
  const legacy = prepareJudgeTask(base);
  assertEquals(legacy.run_id, undefined);
  assertEquals(legacy.problem_version_id, undefined);
  assertEquals(
    legacy.evaluation_protocol_version,
    EVALUATION_PROTOCOL_VERSION,
  );
});

Deno.test("pipeline: OI 任务无尝试时仍生成唯一 run_id（进度/取消键）", () => {
  const oiConfig = {
    backend: "native" as const,
    languages: ["cc"] as const,
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    checker: { type: "default" as const },
    subtasks: [{
      id: "all",
      score: 100,
      cases: [{ input: "1.in", output: "1.out" }],
    }],
  };
  const task = prepareJudgeTask({
    submission_id: "st-oi-1",
    problem_id: "p-1",
    user_id: "u-1",
    priority: "medium",
    runtime_config: {
      ...oiConfig,
      languages: [...oiConfig.languages],
      subtasks: oiConfig.subtasks.map((s) => ({ ...s, cases: [...s.cases] })),
    },
    language: "cc",
    code: "int main(){}",
  });
  assertEquals(typeof task.run_id, "string");
  assertEquals((task.run_id as string).length > 0, true);

  // 有尝试时 OI 的 run_id 必须是尝试 ID（进度事件据此关联）
  const withAttempt = prepareJudgeTask({
    submission_id: "st-oi-2",
    problem_id: "p-1",
    user_id: "u-1",
    priority: "medium",
    runtime_config: {
      ...oiConfig,
      languages: [...oiConfig.languages],
      subtasks: oiConfig.subtasks.map((s) => ({ ...s, cases: [...s.cases] })),
    },
    language: "cc",
    code: "int main(){}",
    attempt_id: "att-oi",
  });
  assertEquals(withAttempt.run_id, "att-oi");
});

Deno.test("pipeline: 协议 v2 结果经 run_id 精确落到尝试", async () => {
  const db = getDb();
  await seedProblem("ap-p6", 991006);

  // 模拟极端场景：提交与在途尝试已落库，但 `active_attempt_id` 不在（例如
  // sweeper 重建/多副本切换），结果只能靠 run_id 定位
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: submissionId,
    user_id: "0",
    problem_id: "ap-p6",
    language: "python",
    code: "print(1)",
    submitted_version_id: "ap-p6-v1",
    version_origin: "known",
    status: "judging",
    created_at: now,
  });
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: "ap-p6",
    problem_version_id: "ap-p6-v1",
    sequence: 0,
    source: "initial",
    state: "judging",
    created_at: now,
  });

  const outcome = await saveEvaluationResult({
    submission_id: submissionId,
    run_id: attemptId,
    evaluation_protocol_version: 2,
    result_kind: "graded",
    status: "finished",
    score: 10000,
    output: "ok",
    details: { cases: [] },
  });
  assertEquals(outcome.applied, true);
  assertEquals(outcome.attempt_applied, "graded");

  const [attempt] = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attemptId),
  );
  assertEquals(attempt.state, "finished");
  assertEquals(attempt.accepted, true);

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, submissionId),
  );
  assertEquals(submission.is_valid, true);
  assertEquals(submission.effective_attempt_id, attemptId);
});
