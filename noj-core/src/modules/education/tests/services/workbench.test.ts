import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { domainProblemBindings } from "../../../../shared/db/schema.ts";
import { recordEducationEvent } from "../../contracts/facts.ts";
import {
  createAssignment,
  createAssignmentHelp,
  getEducationWorkbench,
  publishAssignment,
  setClassroomMember,
} from "../../index.ts";
import { recomputeAssignmentProgress } from "../../services/progress-materializer.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(
    f.school.slug,
    task.id,
    f.teacher,
    0,
    "workbench-publish",
  );
  await recomputeAssignmentProgress(task.id, [f.student]);
  return { ...f, task };
}

Deno.test("教学聚合：当前授权任务及求助，学生仅本人，错误域不包含学校记录", async () => {
  const f = await fixture();
  const help = await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.student,
    "workbench-help",
    { body: "私有正文" },
  );
  const teacher = await getEducationWorkbench(
    f.school.slug,
    f.teacher,
    "teaching",
  );
  assertEquals(teacher.total, 1);
  assertEquals(teacher.assignments[0].summary, {
    total_students: 1,
    total_items: 1,
    achieved_cells: 0,
    below_target_students: 1,
    unavailable_items: 0,
    updating: false,
  });
  assertEquals(teacher.help_requests.map((h) => h.id), [help.id]);
  assertEquals(JSON.stringify(teacher).includes("私有正文"), false);
  const self = await getEducationWorkbench(
    f.school.slug,
    f.student,
    "learning",
  );
  assertEquals(self.total, 1);
  assertEquals(self.assignments[0].summary.total_students, null);
  assertEquals(self.assignments[0].summary.below_target_students, null);
  assertEquals(self.assignments[0].summary.achieved_cells, 0);
  assertEquals(
    (await getEducationWorkbench(f.school.slug, f.student, "teaching")).total,
    0,
  );
  assertEquals(
    (await getEducationWorkbench(f.other.slug, f.teacher, "teaching")).total,
    0,
  );
  assertEquals(
    (await getEducationWorkbench(f.other.slug, f.student, "learning")).total,
    0,
  );
  assertEquals(
    (await getEducationWorkbench(f.school.slug, f.teacher, "teaching", 2))
      .assignments.length,
    0,
  );
});

Deno.test("教学聚合：助教权限分别控制学情、管理与求助，撤权后不保留聚合读取", async () => {
  const f = await fixture();
  await createAssignmentHelp(f.school.slug, f.task.id, f.student, "help", {
    body: "求助",
  });
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["assignments:manage"] },
  );
  const management = await getEducationWorkbench(
    f.school.slug,
    f.assistant,
    "teaching",
  );
  assertEquals(management.total, 1);
  assertEquals(management.assignments[0].summary.total_students, null);
  assertEquals(management.assignments[0].summary.achieved_cells, null);
  assertEquals(management.assignments[0].summary.below_target_students, null);
  assertEquals(management.help_requests.length, 0);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["progress:read", "help:manage"] },
  );
  const authorized = await getEducationWorkbench(
    f.school.slug,
    f.assistant,
    "teaching",
  );
  assertEquals(authorized.assignments[0].summary.total_students, 1);
  assertEquals(authorized.help_requests.length, 1);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    3,
    { role: "assistant", capabilities: [] },
  );
  const revoked = await getEducationWorkbench(
    f.school.slug,
    f.assistant,
    "teaching",
  );
  assertEquals(revoked.total, 0);
  assertEquals(revoked.help_requests.length, 0);
});

Deno.test("教学聚合：策略事件不展示旧达标数，资源下架即时报告且不计为未达标学生", async () => {
  const f = await fixture();
  await f.db.transaction((tx) =>
    recordEducationEvent(tx, {
      domain_id: f.school.id,
      assignment_id: f.task.id,
      event_type: "problem.changed",
    })
  );
  const pending = await getEducationWorkbench(
    f.school.slug,
    f.teacher,
    "teaching",
  );
  assertEquals(pending.assignments[0].summary.updating, true);
  assertEquals(pending.assignments[0].summary.achieved_cells, null);
  assertEquals(pending.assignments[0].summary.below_target_students, null);
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  const unavailable = await getEducationWorkbench(
    f.school.slug,
    f.teacher,
    "teaching",
  );
  assertEquals(unavailable.assignments[0].summary.unavailable_items, 1);
  assertEquals(unavailable.assignments[0].summary.below_target_students, 0);
  assertEquals(unavailable.assignments[0].summary.updating, false);
});
