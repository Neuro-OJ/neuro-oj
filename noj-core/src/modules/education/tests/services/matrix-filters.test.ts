import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  evaluationAttempts,
  submissions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import { recomputeSubmissionProjection } from "../../../evaluations/index.ts";
import { setDomainProblemBindingState } from "../../../problems/index.ts";
import {
  createAssignment,
  exportAssignmentMatrixCsv,
  getAssignmentMatrix,
  getMyAssignmentProgress,
  publishAssignment,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "student" },
  );
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
      code: "student code",
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
      details: { oi: { verdict: "WA" }, expected: "secret answer" },
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

Deno.test("矩阵筛选：学生、题目及状态在分页前匹配，过期成绩不进入达标或错误判定筛选", async () => {
  const f = await fixture();
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      status: "updating",
    })).total,
    2,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      status: "not_started",
    })).total,
    0,
  );
  await grade(f, 4500);
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.assistant);
  const below = await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
    status: "below_target",
  });
  assertEquals(below.total, 1);
  assertEquals(below.rows[0].user_id, f.student);
  const itemId = below.items[0].id;
  assertEquals(below.items[0].reference.display_ref, "1001");
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      verdict: "WA",
      item_id: itemId,
    })).total,
    1,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      student_id: f.assistant,
    })).rows[0].cells[0].status,
    "not_started",
  );
  await grade(f, 8500);
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      status: "below_target",
    })).total,
    0,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      verdict: "WA",
    })).total,
    0,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
      status: "updating",
    })).total,
    1,
  );
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  const achieved = await getAssignmentMatrix(
    f.school.slug,
    f.task.id,
    f.teacher,
    { status: "achieved", item_id: itemId },
  );
  assertEquals(achieved.total, 1);
  assertEquals(achieved.rows[0].cells[0].score, 8500);
  assertEquals(JSON.stringify(achieved).includes("secret"), false);
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 0, {
    disabled: true,
    reason: "保留历史成绩",
  });
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  const retained = await getAssignmentMatrix(
    f.school.slug,
    f.task.id,
    f.teacher,
    { status: "unavailable", verdict: "WA" },
  );
  assertEquals(retained.total, 1);
  assertEquals(retained.rows[0].cells[0].score, 8500);
  await assertRejects(
    () =>
      getAssignmentMatrix(f.school.slug, f.task.id, f.teacher, {
        item_id: crypto.randomUUID(),
      }),
    BadRequestError,
  );
});

Deno.test("矩阵 CSV：共享权限和筛选、整数分转显示分、中文状态及公式字符转义", async () => {
  const f = await fixture();
  await grade(f, 4500);
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  await f.db.update(users).set({ username: '=SUM(1,2)\n"student"' }).where(
    eq(users.id, f.student),
  );
  const csv = await exportAssignmentMatrixCsv(
    f.school.slug,
    f.task.id,
    f.teacher,
    { student_id: f.student },
  );
  const chunks = [];
  for await (const chunk of csv) chunks.push(chunk);
  const text = chunks.join("");
  assertEquals(text.includes('"1001 分数"'), true);
  assertEquals(text.includes('"未达标","45"'), true);
  assertEquals(text.includes('"\'=SUM(1,2)\n""student"""'), true);
  assertEquals(text.includes(f.assistant), false);
  assertEquals(text.includes("secret"), false);
  await grade(f, 8500);
  const pending = await exportAssignmentMatrixCsv(
    f.school.slug,
    f.task.id,
    f.teacher,
    { student_id: f.student },
  );
  const rows = [];
  for await (const chunk of pending) rows.push(chunk);
  assertEquals(rows.join("").includes('"更新中",""'), true);
  assertEquals(rows.join("").includes('"未达标","45"'), false);
  await assertRejects(
    () => exportAssignmentMatrixCsv(f.school.slug, f.task.id, f.student),
    ForbiddenError,
  );
  await assertRejects(
    () => exportAssignmentMatrixCsv(f.other.slug, f.task.id, f.owner),
    NotFoundError,
  );
});
