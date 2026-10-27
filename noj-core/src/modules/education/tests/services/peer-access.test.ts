import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { assignmentFixture } from "../_assignment-fixture.ts";
import { account } from "../_fixtures.ts";
import { addDomainMember } from "../../../access/workspace/index.ts";
import {
  assignments,
  classroomMemberships,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  createClassroom,
  listClassroomMembers,
  publishAssignment,
  setClassroomMember,
} from "../../index.ts";
import { getAssignmentMatrix } from "../../services/progress-read.ts";
import {
  downloadTeachingArtifact,
  getTeachingTextFile,
  listTeachingTextFiles,
} from "../../services/submission-text.ts";
import { getClassroomStudentSubmission } from "../../services/student-submissions.ts";
import { listAssignmentItemSubmissions } from "../../services/submission-evidence.ts";
import { listSubmissionAnnotations } from "../../services/annotations.ts";
import { assignmentHasEnded } from "../../services/peer-access.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";

Deno.test("同班只读：名单与作业进度开放，代码结束后开放且撤权即时生效", async () => {
  const f = await assignmentFixture();
  const peer = f.assistant;
  await setClassroomMember(f.school.slug, f.classroom.id, f.teacher, peer, 1, {
    role: "student",
  });
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const now = new Date().toISOString(), id = crypto.randomUUID();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "cpp",
    code: "private student code",
    file_name: "main.cpp",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: now,
  });
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, peer)).length,
    2,
  );
  const matrix = await getAssignmentMatrix(f.school.slug, task.id, peer);
  assertEquals(matrix.rows.length, 2);
  assertEquals(
    matrix.rows.find((r) => r.user_id === f.student)?.cells[0].can_read_code,
    false,
  );
  assertEquals(
    matrix.rows.find((r) => r.user_id === f.student)?.cells[0]
      .source_submission_id,
    null,
  );
  await assertRejects(
    () =>
      getTeachingTextFile(f.school.slug, f.classroom.id, id, peer, "main.cpp"),
    NotFoundError,
  );
  await assertRejects(
    () => listTeachingTextFiles(f.school.slug, f.classroom.id, id, peer),
    NotFoundError,
  );
  await assertRejects(
    () => downloadTeachingArtifact(f.school.slug, f.classroom.id, id, peer),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        id,
        "submission",
        peer,
      ),
    NotFoundError,
  );
  const itemId = matrix.items[0].id;
  await assertRejects(
    () =>
      listAssignmentItemSubmissions(
        f.school.slug,
        task.id,
        f.student,
        itemId,
        peer,
      ),
    ForbiddenError,
  );
  assertEquals(
    (await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      f.student,
      "main.cpp",
    )).text,
    "private student code",
  );
  await f.db.update(assignments).set({ ended_at: new Date().toISOString() })
    .where(eq(assignments.id, task.id));
  assertEquals(
    (await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      peer,
      "main.cpp",
    )).text,
    "private student code",
  );
  assertEquals(
    (await getClassroomStudentSubmission(
      f.school.slug,
      f.classroom.id,
      id,
      "submission",
      peer,
    )).code,
    "private student code",
  );
  assertEquals(
    (await listAssignmentItemSubmissions(
      f.school.slug,
      task.id,
      f.student,
      itemId,
      peer,
    )).total,
    1,
  );
  await assertRejects(
    () => listSubmissionAnnotations(f.school.slug, f.classroom.id, id, peer),
    NotFoundError,
  );
  // 自然截止与归档同样开放；延长到未来后，下一次请求立即重新拒绝。
  await f.db.update(assignments).set({
    ended_at: null,
    deadline_at: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(assignments.id, task.id));
  assertEquals(
    (await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      peer,
      "main.cpp",
    )).text,
    "private student code",
  );
  await f.db.update(assignments).set({
    deadline_at: new Date(Date.now() + 60000).toISOString(),
  }).where(eq(assignments.id, task.id));
  await assertRejects(
    () =>
      getTeachingTextFile(f.school.slug, f.classroom.id, id, peer, "main.cpp"),
    NotFoundError,
  );
  await f.db.update(assignments).set({ archived_at: new Date().toISOString() })
    .where(eq(assignments.id, task.id));
  assertEquals(
    (await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      peer,
      "main.cpp",
    )).text,
    "private student code",
  );
  await f.db.update(assignments).set({
    archived_at: null,
    ended_at: new Date().toISOString(),
  }).where(eq(assignments.id, task.id));
  // 同题的新练习不能借 assignment_only 作业的结束状态获权。
  await f.db.update(assignments).set({ submission_source: "assignment_only" })
    .where(eq(assignments.id, task.id));
  await assertRejects(
    () =>
      getTeachingTextFile(f.school.slug, f.classroom.id, id, peer, "main.cpp"),
    NotFoundError,
  );
  await f.db.update(submissions).set({
    assignment_id: task.id,
    assignment_item_id: itemId,
  }).where(eq(submissions.id, id));
  assertEquals(
    (await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      peer,
      "main.cpp",
    )).text,
    "private student code",
  );
  const other = await createClassroom(f.school.slug, f.teacher, {
    name: "二班",
  });
  const outsider = await account();
  await addDomainMember(f.db, f.school.id, outsider);
  await setClassroomMember(f.school.slug, other.id, f.teacher, outsider, 0, {
    role: "student",
  });
  await assertRejects(
    () => getAssignmentMatrix(f.school.slug, task.id, outsider),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getTeachingTextFile(f.school.slug, other.id, id, outsider, "main.cpp"),
    NotFoundError,
  );
  await f.db.update(classroomMemberships).set({ status: "removed" }).where(
    eq(classroomMemberships.user_id, f.student),
  );
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, peer)).length,
    1,
  );
  assertEquals(
    (await getAssignmentMatrix(f.school.slug, task.id, peer, {
      recipients: "all",
    })).rows.length,
    1,
  );
  await assertRejects(
    () =>
      getTeachingTextFile(f.school.slug, f.classroom.id, id, peer, "main.cpp"),
    NotFoundError,
  );
  await f.db.update(classroomMemberships).set({ status: "removed" }).where(
    eq(classroomMemberships.user_id, peer),
  );
  await assertRejects(
    () => getAssignmentMatrix(f.school.slug, task.id, peer),
    ForbiddenError,
  );
});

Deno.test("作业结束：截止、提前结束和归档；无期限及未来日期保持进行中", () => {
  const empty = { deadline_at: null, ended_at: null, archived_at: null };
  assertEquals(assignmentHasEnded(empty), false);
  for (const key of ["deadline_at", "ended_at", "archived_at"] as const) {
    assertEquals(
      assignmentHasEnded({
        ...empty,
        [key]: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    assertEquals(
      assignmentHasEnded({
        ...empty,
        [key]: new Date(Date.now() + 60000).toISOString(),
      }),
      false,
    );
  }
});
