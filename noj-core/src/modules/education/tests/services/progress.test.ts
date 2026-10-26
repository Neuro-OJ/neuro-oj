import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  assignmentItemHistory,
  assignmentItems,
  assignmentProgress,
  assignmentRecipients,
  assignments,
  contests,
  domainProblemBindings,
  evaluationAttempts,
  objectiveSubmissions,
  problemBindingHistory,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import { recordEducationEvent } from "../../contracts/facts.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { recomputeAssignmentProgress } from "../../services/progress-materializer.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "publish");
  const published = "2026-10-01T00:00:00.000Z",
    deadline = "2026-10-02T00:00:00.000Z";
  await f.db.update(assignments).set({
    published_at: published,
    deadline_at: deadline,
  }).where(eq(assignments.id, draft.id));
  await f.db.update(assignmentRecipients).set({
    credit_intervals: [{ start: published, end: null }],
  }).where(eq(assignmentRecipients.assignment_id, draft.id));
  return { ...f, assignmentId: draft.id, published, deadline };
}

async function submission(
  f: Awaited<ReturnType<typeof fixture>>,
  input: {
    score: number;
    accepted?: boolean;
    received?: string;
    pending?: boolean;
    domainId?: string;
    bindingId?: string;
    contestId?: string;
  },
) {
  const id = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    bucketId = crypto.randomUUID();
  await f.db.transaction(async (tx) => {
    await tx.insert(submissions).values({
      id,
      domain_id: input.domainId ?? f.school.id,
      domain_problem_binding_id: input.bindingId ?? f.bindingId,
      contest_id: input.contestId,
      user_id: f.student,
      problem_id: f.problemId,
      language: "python",
      code: "print(1)",
      submitted_version_id: f.versionId,
      version_origin: "known",
      created_at: input.received ?? "2026-10-01T12:00:00.000Z",
    });
    await tx.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: id,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      sequence: 0,
      source: "initial",
      state: input.pending ? "queued" : "finished",
      result_kind: input.pending ? null : "graded",
      score: input.pending ? null : input.score,
      accepted: input.accepted ?? false,
      created_at: new Date().toISOString(),
    });
    if (input.pending) {
      await tx.update(submissions).set({ active_attempt_id: attemptId }).where(
        eq(submissions.id, id),
      );
    } else {await tx.insert(submissionVersionResults).values({
        id: bucketId,
        submission_id: id,
        problem_id: f.problemId,
        problem_version_id: f.versionId,
        current_attempt_id: attemptId,
        updated_at: new Date().toISOString(),
      });}
    await recordEducationEvent(tx, {
      domain_id: input.domainId ?? f.school.id,
      user_id: f.student,
      problem_id: f.problemId,
      event_type: "submission.changed",
    });
  });
  return { id, attemptId, bucketId };
}

Deno.test("作业成绩：按受理时间分离按时与补做，发布前默认不计，在途可后补", async () => {
  const f = await fixture();
  await submission(f, { score: 10000, received: "2026-09-30T00:00:00.000Z" });
  const timely = await submission(f, { score: 2000, pending: true });
  await submission(f, { score: 8000, received: "2026-10-02T12:00:00.000Z" });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  let cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.find((c) => c.scope === "on_time")?.status, "judging");
  assertEquals(cells.find((c) => c.scope === "current")?.score, 8000);
  assertEquals(cells.find((c) => c.scope === "current")?.late, true);
  await f.db.transaction(async (tx) => {
    await tx.update(evaluationAttempts).set({
      state: "finished",
      result_kind: "graded",
      score: 7000,
    })
      .where(eq(evaluationAttempts.id, timely.attemptId));
    await tx.insert(submissionVersionResults).values({
      id: timely.bucketId,
      submission_id: timely.id,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      current_attempt_id: timely.attemptId,
      updated_at: new Date().toISOString(),
    });
    await tx.update(submissions).set({ active_attempt_id: null }).where(
      eq(submissions.id, timely.id),
    );
    await recordEducationEvent(tx, {
      domain_id: f.school.id,
      user_id: f.student,
      problem_id: f.problemId,
      event_type: "submission.changed",
    });
  });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.find((c) => c.scope === "on_time")?.score, 7000);
  assertEquals(cells.find((c) => c.scope === "on_time")?.status, "achieved");
  assertEquals(cells.find((c) => c.scope === "current")?.score, 8000);
});

Deno.test("作业成绩：重算读取当前正式判定，降分、重复与撤销资源保留依据", async () => {
  const f = await fixture();
  const source = await submission(f, { score: 9000 });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  assertEquals((await f.db.select().from(assignmentProgress))[0].score, 9000);
  await f.db.transaction(async (tx) => {
    const newAttempt = crypto.randomUUID();
    await tx.insert(evaluationAttempts).values({
      id: newAttempt,
      submission_id: source.id,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      source: "rejudge",
      sequence: 1,
      state: "finished",
      result_kind: "graded",
      score: 2000,
      created_at: new Date().toISOString(),
    });
    await tx.update(submissionVersionResults).set({
      current_attempt_id: newAttempt,
    }).where(eq(submissionVersionResults.id, source.bucketId));
    await recordEducationEvent(tx, {
      domain_id: f.school.id,
      user_id: f.student,
      problem_id: f.problemId,
      event_type: "submission.changed",
    });
  });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  let cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.length, 2);
  assertEquals(cells[0].score, 2000);
  assertEquals(cells[0].status, "below_target");
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells[0].status, "unavailable");
  assertEquals(cells[0].score, 2000);
  assertEquals(cells[0].source_submission_id, source.id);
});

Deno.test("作业成绩：同域一次提交可计两份任务，其他域和赛中成绩不会混入", async () => {
  const f = await fixture();
  const timely = await submission(f, { score: 7000 });
  const second = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, second.id, f.teacher, 0, "second");
  await f.db.update(assignments).set({ published_at: f.published }).where(
    eq(assignments.id, second.id),
  );
  await f.db.update(assignmentRecipients).set({
    credit_intervals: [{ start: f.published, end: null }],
  })
    .where(eq(assignmentRecipients.assignment_id, second.id));
  const otherBinding = crypto.randomUUID();
  await f.db.insert(domainProblemBindings).values({
    id: otherBinding,
    domain_id: f.other.id,
    problem_id: f.problemId,
    kind: "shared",
    created_by: f.owner,
    created_at: f.published,
    updated_at: f.published,
  });
  await submission(f, {
    score: 10000,
    domainId: f.other.id,
    bindingId: otherBinding,
  });
  const contestId = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.insert(contests).values({
    id: contestId,
    domain_id: f.school.id,
    title: "保密 OI",
    start_time: "2026-10-01T00:00:00.000Z",
    end_time: "2026-11-01T00:00:00.000Z",
    type: "oi",
    created_at: now,
    updated_at: now,
  });
  await submission(f, { score: 9500, contestId });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  await recomputeAssignmentProgress(second.id, [f.student]);
  const cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.length, 4);
  assertEquals(
    cells.every((c) =>
      c.score === 7000 && c.source_submission_id === timely.id
    ),
    true,
  );
  await f.db.update(contests).set({ end_time: "2026-10-02T00:00:00.000Z" })
    .where(eq(contests.id, contestId));
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  assertEquals(
    (await f.db.select().from(assignmentProgress).where(
      eq(assignmentProgress.assignment_id, f.assignmentId),
    ))[0].score,
    9500,
  );
});

Deno.test("作业成绩：客观题通过正式尝试计入，不读取标准答案或原始详情", async () => {
  const f = await fixture();
  const id = crypto.randomUUID(), attemptId = crypto.randomUUID();
  await f.db.insert(objectiveSubmissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    paper_id: f.problemId,
    user_id: f.student,
    submission_type: "practice",
    answers: { private: "answer" },
    score: 8000,
    details: { expected: "must-not-leak" },
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: "2026-10-01T12:00:00.000Z",
  });
  await f.db.insert(evaluationAttempts).values({
    id: attemptId,
    objective_submission_id: id,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    score: 8000,
    accepted: false,
    details: { expected: "must-not-leak" },
    output: "must-not-leak",
    created_at: new Date().toISOString(),
  });
  await f.db.insert(submissionVersionResults).values({
    id: crypto.randomUUID(),
    objective_submission_id: id,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    current_attempt_id: attemptId,
    updated_at: new Date().toISOString(),
  });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  const cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells[0].score, 8000);
  assertEquals(cells[0].source_kind, "objective");
  assertEquals(cells[0].accepted, false);
  assertEquals(cells[0].status, "achieved");
  assertEquals(JSON.stringify(cells).includes("must-not-leak"), false);
});

Deno.test("作业成绩：any 新版切换和 exact 策略沿革，正式通过不等于最高分", async () => {
  const f = await fixture();
  const original = await submission(f, { score: 9000, accepted: false });
  const v2 = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.insert(problemVersions).values({
    id: v2,
    problem_id: f.problemId,
    version: 2,
    content: { kind: "ai", title: "新版", description: "新题面" },
    published_by: f.owner,
    published_at: now,
  });
  await f.db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, f.problemId),
  );
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  let [item] = await f.db.select().from(assignmentItems);
  assertEquals(item.answer_version_id, v2);
  assertEquals(item.published_version_id, f.versionId);
  assertEquals((await f.db.select().from(assignmentProgress))[0].score, 9000);
  await f.db.update(domainProblemBindings).set({
    effective_version_mode: "exact",
    required_version_id: v2,
    revision: 1,
  })
    .where(eq(domainProblemBindings.id, f.bindingId));
  await f.db.insert(problemBindingHistory).values({
    id: crypto.randomUUID(),
    binding_id: f.bindingId,
    problem_id: f.problemId,
    revision: 1,
    effective_version_mode: "exact",
    required_version_id: v2,
    answer_version_id: v2,
    actor_id: f.teacher,
    reason: "采用新版",
    created_at: now,
  });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  assertEquals((await f.db.select().from(assignmentProgress))[0].score, null);
  const newAttempt = crypto.randomUUID();
  await f.db.insert(evaluationAttempts).values({
    id: newAttempt,
    submission_id: original.id,
    problem_id: f.problemId,
    problem_version_id: v2,
    sequence: 1,
    source: "rejudge",
    state: "finished",
    result_kind: "graded",
    score: 5000,
    accepted: true,
    created_at: now,
  });
  await f.db.insert(submissionVersionResults).values({
    id: crypto.randomUUID(),
    submission_id: original.id,
    problem_id: f.problemId,
    problem_version_id: v2,
    current_attempt_id: newAttempt,
    updated_at: now,
  });
  await recomputeAssignmentProgress(f.assignmentId, [f.student]);
  const cell = (await f.db.select().from(assignmentProgress))[0];
  assertEquals(cell.score, 5000);
  assertEquals(cell.accepted, true);
  assertEquals(cell.status, "below_target");
  [item] = await f.db.select().from(assignmentItems);
  assertEquals(item.policy_revision, 1);
  const history = await f.db.select().from(assignmentItemHistory);
  assertEquals(
    history.find((h) => h.policy_revision === 1)?.actor_id,
    f.teacher,
  );
  assertEquals(
    history.find((h) => h.answer_version_id === v2 && h.policy_mode === "any")
      ?.actor_id,
    f.owner,
  );
});
