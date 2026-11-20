import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import {
  assignmentProgress,
  assignmentRecipients,
  assignments,
  classroomMemberships,
  domainMemberships,
} from "../../../../shared/db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { recordEducationEvent } from "../../contracts/facts.ts";
import {
  createAssignment,
  createAssignmentRemediation,
  previewAssignmentRemediation,
  publishAssignment,
} from "../../index.ts";
import { recomputeAssignmentProgress } from "../../services/progress-materializer.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";
import { account } from "../_fixtures.ts";

Deno.test("全班补题：跨过矩阵第一页、排除待评测与历史学生、重试不复制原成绩", async () => {
  const f = await assignmentFixture(), now = new Date().toISOString();
  const additional: string[] = [];
  for (let i = 0; i < 55; i++) additional.push(await account());
  await f.db.insert(domainMemberships).values(
    additional.map((id) => ({
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      user_id: id,
      joined_at: now,
    })),
  );
  await f.db.insert(classroomMemberships).values(
    additional.map((id) => ({
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      classroom_id: f.classroom.id,
      user_id: id,
      role: "student" as const,
      joined_at: now,
      appointed_at: now,
    })),
  );
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const published = await publishAssignment(
    f.school.slug,
    task.id,
    f.teacher,
    0,
    "publish-remediation",
  );
  const initial = await previewAssignmentRemediation(
    f.school.slug,
    task.id,
    f.teacher,
  );
  assertEquals(initial.students.length, 0);
  assertEquals(initial.updating, true);
  assertEquals(initial.excluded.pending_cells, 56);
  await recomputeAssignmentProgress(task.id, [f.student, ...additional]);
  const full = await previewAssignmentRemediation(
    f.school.slug,
    task.id,
    f.teacher,
  );
  assertEquals(full.students.length, 56);
  assertEquals(full.students.some((s) => s.user_id === additional[54]), true);
  assertEquals(full.updating, false);
  await f.db.update(assignmentProgress).set({ status: "judging" }).where(
    and(
      eq(assignmentProgress.assignment_id, task.id),
      eq(assignmentProgress.user_id, additional[0]),
    ),
  );
  await f.db.update(assignmentRecipients).set({
    status: "historical",
    left_at: now,
  }).where(
    and(
      eq(assignmentRecipients.assignment_id, task.id),
      eq(assignmentRecipients.user_id, additional[1]),
    ),
  );
  const preview = await previewAssignmentRemediation(
    f.school.slug,
    task.id,
    f.teacher,
  );
  assertEquals(preview.students.length, 54);
  assertEquals(preview.excluded.pending_cells, 1);
  assertEquals(preview.excluded.historical_students, 1);
  const input = {
    title: "全班补题",
    scope: "on_time" as const,
    preview_token: preview.preview_token,
    target_student_ids: preview.students.map((s) => s.user_id),
    item_ids: [preview.items[0].id],
  };
  const before = await f.db.select().from(assignmentProgress).where(
    eq(assignmentProgress.assignment_id, task.id),
  );
  const copy = await createAssignmentRemediation(
    f.school.slug,
    task.id,
    f.teacher,
    published.revision,
    "whole-class-remediation",
    input,
  );
  assertEquals(copy.state, "draft");
  assertEquals(copy.source_assignment_id, task.id);
  assertEquals(copy.target_student_ids?.length, 54);
  assertEquals(
    (await createAssignmentRemediation(
      f.school.slug,
      task.id,
      f.teacher,
      published.revision,
      "whole-class-remediation",
      input,
    )).id,
    copy.id,
  );
  assertEquals(
    await f.db.select().from(assignmentProgress).where(
      eq(assignmentProgress.assignment_id, task.id),
    ),
    before,
  );
  assertEquals((await f.db.select().from(assignments)).length, 2);
});

Deno.test("全班补题：学生或错误域不可预览，候选变更要求重新确认", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const published = await publishAssignment(
    f.school.slug,
    task.id,
    f.teacher,
    0,
    "publish-remediation",
  );
  await recomputeAssignmentProgress(task.id, [f.student]);
  await assertRejects(
    () => previewAssignmentRemediation(f.school.slug, task.id, f.student),
    ForbiddenError,
  );
  await assertRejects(
    () => previewAssignmentRemediation(f.other.slug, task.id, f.teacher),
    NotFoundError,
  );
  const preview = await previewAssignmentRemediation(
    f.school.slug,
    task.id,
    f.teacher,
  );
  await f.db.transaction((tx) =>
    recordEducationEvent(tx, {
      domain_id: f.school.id,
      problem_id: f.problemId,
      event_type: "problem.changed",
    })
  );
  const changed = await assertRejects(
    () =>
      createAssignmentRemediation(
        f.school.slug,
        task.id,
        f.teacher,
        published.revision,
        "changed-preview",
        {
          title: "补题",
          scope: "on_time",
          preview_token: preview.preview_token,
          target_student_ids: [f.student],
          item_ids: [preview.items[0].id],
        },
      ),
    ConflictError,
  );
  assertEquals(changed.code, "REMEDIATION_PREVIEW_CHANGED");
  assertEquals((await f.db.select().from(assignments)).length, 1);
});
