import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  assignmentProgress,
  contests,
  educationOutbox,
  evaluationAttempts,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  deleteSubmission,
  recomputeSubmissionProjection,
} from "../../../submission/index.ts";
import { rescheduleContestEducation } from "../../../../shared/education-contests.ts";
import {
  createAssignment,
  getMyAssignmentProgress,
  publishAssignment,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  return { ...f, task };
}
async function grade(
  f: Awaited<ReturnType<typeof fixture>>,
  score: number,
  contestId?: string,
) {
  const id = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.transaction(async (tx) => {
    await tx.insert(submissions).values({
      id,
      domain_id: f.school.id,
      domain_problem_binding_id: f.bindingId,
      user_id: f.student,
      problem_id: f.problemId,
      contest_id: contestId,
      language: "python",
      code: "immutable code",
      status: "finished",
      submitted_version_id: f.versionId,
      version_origin: "known",
      created_at: now,
    });
    await tx.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: id,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      score,
      created_at: now,
    });
    await tx.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      submission_id: id,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      current_attempt_id: attemptId,
      updated_at: now,
    });
    await recomputeSubmissionProjection(tx, {
      kind: "submission",
      id,
      problem_id: f.problemId,
      domain_problem_binding_id: f.bindingId,
      contest_id: contestId ?? null,
    });
  });
  return id;
}
async function drain() {
  for (let i = 0; i < 30; i++) {
    if (!(await processEducationBatch()).length) break;
  }
}

Deno.test("提交删除：释放进度引用、保留目标名单并自动改用另一份正式成绩", async () => {
  const f = await fixture();
  const low = await grade(f, 3000), high = await grade(f, 9000);
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    9000,
  );
  await deleteSubmission(high);
  await drain();
  const cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.length, 2);
  assertEquals(
    cells.every((c) => c.score === 3000 && c.source_submission_id === low),
    true,
  );
});

Deno.test("比赛结束：持久到期事件补算，延长比赛重排时刻，赛中不暴露成绩", async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(contests).values({
    id,
    domain_id: f.school.id,
    title: "OI",
    type: "oi",
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await grade(f, 9500, id);
  await drain();
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    null,
  );
  const later = new Date(Date.now() + 120000).toISOString();
  await f.db.transaction(async (tx) => {
    await tx.update(contests).set({ end_time: later }).where(
      eq(contests.id, id),
    );
    await rescheduleContestEducation(tx, id, later);
  });
  const queued = await f.db.select().from(educationOutbox);
  assertEquals(
    queued.filter((e) => e.payload._invalidate_on_claim === true).every((e) =>
      e.available_at === later
    ),
    true,
  );
  const ended = new Date(Date.now() - 1000).toISOString();
  await f.db.transaction(async (tx) => {
    await tx.update(contests).set({ end_time: ended }).where(
      eq(contests.id, id),
    );
    await rescheduleContestEducation(tx, id, ended);
  });
  await drain();
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    9500,
  );
});
