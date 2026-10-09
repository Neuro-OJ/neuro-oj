/**
 * 评测尝试生命周期与结果落库事务测试（Handbook §5.4、§5.6、§1.3）。
 *
 * 覆盖：初次尝试 sequence=0 且设置 active_attempt_id、重测递增 sequence、
 * 终态只写一次（重复/过时消息不覆盖）、graded 更新当前判定与双口径投影、
 * 平台错误不替换已有正式判定、exact 策略下 graded 结果不产生有效成绩。
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
  createAttempt,
  finishAttempt,
  getAttempt,
  markAttemptStarted,
  nextAttemptSequence,
  supersedeAttempt,
} from "../../services/versioning/attempts.ts";
import {
  applyAttemptResult,
  listAttempts,
} from "../../services/versioning/result-write.ts";
import type { ProjectionSource } from "../../services/versioning/projection.ts";

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
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: `${problemId}-v1`,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content: { kind: "ai", title: problemId },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: `${problemId}-v1` })
    .where(eq(problems.id, problemId));
}

async function seedSubmission(
  id: string,
  problemId: string,
): Promise<ProjectionSource> {
  await getDb().insert(submissions).values({
    id,
    user_id: "0",
    problem_id: problemId,
    language: "python",
    code: "print(1)",
    submitted_version_id: `${problemId}-v1`,
    version_origin: "known",
    status: "judging",
    created_at: now,
  });
  return {
    kind: "submission",
    id,
    problem_id: problemId,
    contest_id: null,
  };
}

Deno.test("attempt: 初次尝试 sequence=0 并设置 active_attempt_id", async () => {
  const db = getDb();
  await seedProblem("rw-p1", 990001);
  const source = await seedSubmission("rw-s1", "rw-p1");

  const attempt = await createAttempt({
    source,
    problemVersionId: "rw-p1-v1",
    source_kind: "initial",
    taskSnapshot: { language: "python", problem_version_id: "rw-p1-v1" },
  });
  assertEquals(attempt.sequence, 0);
  assertEquals(attempt.state, "queued");

  const [row] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s1"),
  );
  assertEquals(row.active_attempt_id, attempt.id);

  // 重测递增 sequence
  assertEquals(await nextAttemptSequence(source), 1);
  const second = await createAttempt({
    source,
    problemVersionId: "rw-p1-v1",
    source_kind: "rejudge",
  });
  assertEquals(second.sequence, 1);
  const [row2] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s1"),
  );
  assertEquals(row2.active_attempt_id, second.id);

  await markAttemptStarted(second.id);
  assertEquals((await getAttempt(second.id))?.state, "judging");
});

Deno.test("attempt: 终态只写一次", async () => {
  await seedProblem("rw-p2", 990002);
  const source = await seedSubmission("rw-s2", "rw-p2");
  const attempt = await createAttempt({
    source,
    problemVersionId: "rw-p2-v1",
    source_kind: "initial",
  });

  assertEquals(
    await finishAttempt({
      attemptId: attempt.id,
      resultKind: "graded",
      resultStatus: "finished",
      score: 1000,
      accepted: false,
    }),
    true,
  );
  // 重复回调不覆盖
  assertEquals(
    await finishAttempt({
      attemptId: attempt.id,
      resultKind: "graded",
      resultStatus: "finished",
      score: 10000,
      accepted: true,
    }),
    false,
  );
  const row = await getAttempt(attempt.id);
  assertEquals(row?.state, "finished");
  const [full] = await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attempt.id),
  );
  assertEquals(full.score, 1000);
  assertEquals(full.accepted, false);

  // superseded 也不接受终态覆盖方向（已是终态 → 不改）
  await supersedeAttempt(attempt.id);
  assertEquals((await getAttempt(attempt.id))?.state, "finished");
});

Deno.test("attempt: superseded 后不再接受结果", async () => {
  await seedProblem("rw-p3", 990003);
  const source = await seedSubmission("rw-s3", "rw-p3");
  const attempt = await createAttempt({
    source,
    problemVersionId: "rw-p3-v1",
    source_kind: "initial",
  });
  await supersedeAttempt(attempt.id);
  assertEquals((await getAttempt(attempt.id))?.state, "superseded");
  assertEquals(
    await finishAttempt({
      attemptId: attempt.id,
      resultKind: "graded",
      resultStatus: "finished",
      score: 10000,
      accepted: true,
    }),
    false,
  );
});

Deno.test("result write: graded 写入当前判定与双口径投影", async () => {
  const db = getDb();
  await seedProblem("rw-p4", 990004);
  const source = await seedSubmission("rw-s4", "rw-p4");
  const attempt = await createAttempt({
    source,
    problemVersionId: "rw-p4-v1",
    source_kind: "initial",
  });

  const outcome = await db.transaction(async (tx) =>
    await applyAttemptResult({
      attemptId: attempt.id,
      resultKind: "graded",
      resultStatus: "finished",
      score: 8800,
      accepted: true,
      output: "ok",
      details: { cases: [] },
    }, tx)
  );
  assertEquals(outcome.applied, "graded");

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s4"),
  );
  assertEquals(submission.is_valid, true);
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.effective_attempt_id, attempt.id);
  assertEquals(submission.accepted_attempt_id, attempt.id);
  assertEquals(submission.active_attempt_id, null);
  assertEquals(submission.latest_attempt_id, attempt.id);
  assertEquals(submission.status, "finished");

  // 分版本当前判定指针
  const results = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, "rw-s4"),
  );
  assertEquals(results.length, 1);
  assertEquals(results[0].problem_version_id, "rw-p4-v1");
  assertEquals(results[0].current_attempt_id, attempt.id);
});

Deno.test("result write: 重复/过时结果被忽略", async () => {
  const db = getDb();
  await seedProblem("rw-p5", 990005);
  const source = await seedSubmission("rw-s5", "rw-p5");
  const first = await createAttempt({
    source,
    problemVersionId: "rw-p5-v1",
    source_kind: "initial",
  });
  await applyAttemptResult({
    attemptId: first.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });

  // 重复消费同一条消息
  const again = await applyAttemptResult({
    attemptId: first.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });
  assertEquals(again.applied, "ignored");

  // 旧尝试（已被新尝试顶替）的结果 = 过时
  const second = await createAttempt({
    source,
    problemVersionId: "rw-p5-v1",
    source_kind: "rejudge",
  });
  const stale = await applyAttemptResult({
    attemptId: first.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 0,
    accepted: false,
  });
  assertEquals(stale.applied, "ignored");

  // 新尝试的结果正常应用，并且不覆盖第一版（同版本判定被替换）
  const applied = await applyAttemptResult({
    attemptId: second.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 5000,
    accepted: false,
  });
  assertEquals(applied.applied, "graded");
  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s5"),
  );
  assertEquals(submission.is_accepted, false);
  assertEquals(submission.is_valid, true);
  assertEquals(submission.effective_attempt_id, second.id);
  assertEquals(submission.accepted_attempt_id, null);

  // 不存在的尝试
  assertEquals(
    (await applyAttemptResult({
      attemptId: "ghost",
      resultKind: "graded",
      resultStatus: "finished",
      score: 1,
      accepted: false,
    })).applied,
    "ignored",
  );
});

Deno.test("result write: 平台错误不替换已有正式判定", async () => {
  const db = getDb();
  await seedProblem("rw-p6", 990006);
  const source = await seedSubmission("rw-s6", "rw-p6");
  const good = await createAttempt({
    source,
    problemVersionId: "rw-p6-v1",
    source_kind: "initial",
  });
  await applyAttemptResult({
    attemptId: good.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });

  const failing = await createAttempt({
    source,
    problemVersionId: "rw-p6-v1",
    source_kind: "rejudge",
  });
  const outcome = await applyAttemptResult({
    attemptId: failing.id,
    resultKind: "platform_error",
    resultStatus: "error",
    score: null,
    accepted: false,
    output: "支持包缺失",
  });
  assertEquals(outcome.applied, "platform_error");

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s6"),
  );
  // 已有正式判定保留：仍然通过、指针仍指向失败的旧尝试
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.effective_attempt_id, good.id);
  assertEquals(submission.accepted_attempt_id, good.id);
  // 最近尝试与运行状态更新
  assertEquals(submission.latest_attempt_id, failing.id);
  assertEquals(submission.status, "error");
  assertEquals(submission.active_attempt_id, null);

  // 分版本当前判定仍指向旧的成功尝试
  const results = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, "rw-s6"),
  );
  assertEquals(results.length, 1);
  assertEquals(results[0].current_attempt_id, good.id);
});

Deno.test("result write: exact 策略下 graded 结果不产生有效成绩", async () => {
  const db = getDb();
  await seedProblem("rw-p7", 990007);
  const source = await seedSubmission("rw-s7", "rw-p7");
  const attempt = await createAttempt({
    source,
    problemVersionId: "rw-p7-v1",
    source_kind: "initial",
  });
  // 建第二版并切换到 exact(V2)：V1 上的 graded 结果不再有效
  await db.insert(problemVersions).values({
    id: "rw-p7-v2",
    problem_id: "rw-p7",
    version: 2,
    origin: "published",
    content: { kind: "ai", title: "rw-p7" },
    published_at: now,
  });
  await db.update(problems).set({
    latest_version_id: "rw-p7-v2",
    effective_version_mode: "exact",
    required_version_id: "rw-p7-v2",
    effective_policy_revision: 1,
  }).where(eq(problems.id, "rw-p7"));

  const outcome = await applyAttemptResult({
    attemptId: attempt.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });
  assertEquals(outcome.applied, "graded");
  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "rw-s7"),
  );
  // 判定已记录，但当前策略不接受该版本 → 无有效成绩
  assertEquals(submission.is_valid, false);
  assertEquals(submission.is_accepted, false);
  assertEquals(submission.effective_attempt_id, null);
  assertEquals(submission.global_policy_revision, 1);

  // 切回 any 后，已有判定立即可用（不需要重新评测）
  await db.update(problems).set({
    effective_version_mode: "any",
    required_version_id: null,
    effective_policy_revision: 2,
  }).where(eq(problems.id, "rw-p7"));
  const outcome2 = await applyAttemptResult({
    attemptId: attempt.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });
  // 终态已写，重复消息被忽略；策略切换由 recomputeProblemProjections 负责
  assertEquals(outcome2.applied, "ignored");
});

Deno.test("attempt: listAttempts 按 sequence 升序", async () => {
  await seedProblem("rw-p8", 990008);
  const source = await seedSubmission("rw-s8", "rw-p8");
  await createAttempt({
    source,
    problemVersionId: "rw-p8-v1",
    source_kind: "initial",
  });
  await createAttempt({
    source,
    problemVersionId: "rw-p8-v1",
    source_kind: "rejudge",
  });
  const attempts = await listAttempts(source);
  assertEquals(attempts.map((attempt) => attempt.sequence), [0, 1]);
});
