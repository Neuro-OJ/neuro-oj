import { setMemberRole } from "../../../access/workspace/index.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { accountNotifications } from "../../../../shared/db/schema.ts";
import {
  setDomainProblemBindingPolicy,
  setDomainProblemBindingState,
} from "../../../problems/index.ts";
import {
  changeAssignmentLifecycle,
  createAssignment,
  getMyAssignmentProgress,
  listEducationNotifications,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";
async function drain() {
  for (let i = 0; i < 40; i++) {
    if (!(await processEducationBatch()).length) break;
  }
}

Deno.test("任务通知：发布同事务创建，学生与授权教学人员收到，新生补入只通知本人", async () => {
  const f = await assignmentFixture();
  await setMemberRole(f.school.slug, f.owner, f.assistant, "educator");
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  await drain();
  for (const actor of [f.teacher, f.assistant, f.student]) {
    const notices = await listEducationNotifications(f.school.slug, actor);
    assertEquals(notices.total, 1);
    assertEquals(notices.data[0].type, "assignment");
    assertEquals("title" in notices.data[0], false);
    assertEquals("score" in notices.data[0], false);
  }
  await setClassroomMember(f.school.slug, f.classroom.id, f.owner, f.owner, 1, {
    role: "student",
  });
  await drain();
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.owner)).data[0].type,
    "assignment",
  );
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).total,
    1,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "member");
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.assistant)).total,
    0,
  );
});

Deno.test("任务通知：策略变化一次投递，资源撤销／恢复各自通知，重算与重试不重复通知", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  await drain();
  await setDomainProblemBindingPolicy(f.school.slug, "1001", f.owner, 0, {
    mode: "exact",
    version_id: f.versionId,
  }, "切换有效版本");
  await drain();
  const changed = await listEducationNotifications(f.school.slug, f.student);
  assertEquals(
    changed.data.filter((n) => n.type === "assignment_changed").length,
    1,
  );
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 1, {
    disabled: true,
    reason: "临时下架",
  });
  await drain();
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.teacher)).data.some(
      (n) => n.type === "resource_unavailable",
    ),
    true,
  );
  const before = (await f.db.select().from(accountNotifications)).length;
  await getMyAssignmentProgress(f.school.slug, task.id, f.student);
  await drain();
  assertEquals(
    (await f.db.select().from(accountNotifications)).length,
    before,
  );
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 2, {
    disabled: false,
    reason: "恢复授权",
  });
  await drain();
  // 恢复授权后再通知一次作业变化
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).data.filter(
      (n) => n.type === "assignment_changed",
    ).length,
    2,
  );
});

Deno.test("任务通知：延长截止和归档逐次通知", async () => {
  const f = await assignmentFixture(),
    task = await createAssignment(f.school.slug, f.classroom.id, f.teacher, {
      ...f.input,
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    });
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  await changeAssignmentLifecycle(f.school.slug, task.id, f.teacher, 1, {
    action: "extend",
    reason: "延长练习",
    deadline_at: new Date(Date.now() + 120000).toISOString(),
  });
  await drain();
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).total,
    2,
  );
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  await changeAssignmentLifecycle(f.school.slug, task.id, f.teacher, 2, {
    action: "archive",
    reason: "完成归档",
  });
  await drain();
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).total,
    3,
  );
});
