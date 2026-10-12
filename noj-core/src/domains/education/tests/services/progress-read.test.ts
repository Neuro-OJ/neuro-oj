import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  educationOutbox,
  evaluationAttempts,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import { recomputeSubmissionProjection } from "../../../submission/index.ts";
import {
  createAssignment,
  getAssignmentMatrix,
  getMyAssignmentProgress,
  publishAssignment,
  setClassroomMember,
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

async function grade(f: Awaited<ReturnType<typeof fixture>>, score: number) {
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
      language: "python",
      code: "secret student code",
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
      details: { expected: "secret evaluator data" },
      output: "secret evaluator data",
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
      contest_id: null,
    });
  });
}

Deno.test("矩阵：学生仅本人进度，助教学情授权独立，数据不包含源码或评测文本", async () => {
  const f = await fixture();
  await grade(f, 7000);
  const own = await getMyAssignmentProgress(
    f.school.slug,
    f.task.id,
    f.student,
  );
  assertEquals(own.cells[0].score, 7000);
  assertEquals(own.updating, false);
  assertEquals(JSON.stringify(own).includes("secret"), false);
  await assertRejects(
    () => getAssignmentMatrix(f.school.slug, f.task.id, f.student),
    ForbiddenError,
  );
  await assertRejects(
    () => getMyAssignmentProgress(f.other.slug, f.task.id, f.student),
    NotFoundError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  const matrix = await getAssignmentMatrix(
    f.school.slug,
    f.task.id,
    f.assistant,
  );
  assertEquals(matrix.total, 1);
  assertEquals(matrix.rows[0].cells[0].score, 7000);
  assertEquals(JSON.stringify(matrix).includes("secret"), false);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["feedback:write"] },
  );
  await assertRejects(
    () => getAssignmentMatrix(f.school.slug, f.task.id, f.assistant),
    ForbiddenError,
  );
});

Deno.test("矩阵：过期口径明确更新中，并发补算合并，学生同步读取最新分", async () => {
  const f = await fixture();
  await grade(f, 7000);
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  await grade(f, 9000);
  const matrices = await Promise.all([
    getAssignmentMatrix(f.school.slug, f.task.id, f.teacher),
    getAssignmentMatrix(f.school.slug, f.task.id, f.teacher),
  ]);
  assertEquals(
    matrices.every((m) => m.updating && m.rows[0].cells[0].score === null),
    true,
  );
  const refreshes = await f.db.select().from(educationOutbox).where(
    eq(educationOutbox.event_type, "assignment.refresh"),
  );
  assertEquals(refreshes.length, 1);
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    9000,
  );
  await processEducationBatch();
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher)).updating,
    false,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      search: "\\",
    })).total,
    0,
  );
});
