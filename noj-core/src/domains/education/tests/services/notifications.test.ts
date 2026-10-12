import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import {
  educationNotifications,
  educationOutbox,
} from "../../../../shared/db/schema.ts";
import { recordEducationNotice } from "../../../../shared/education-events.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  createAssignmentHelp,
  listEducationNotifications,
  markEducationNotificationRead,
  publishAssignment,
  replyAssignmentHelp,
  setClassroomMember,
  updateAssignmentFeedback,
} from "../../index.ts";
import {
  claimEducationEvents,
  processEducationBatch,
  processEducationEvent,
} from "../../services/progress-worker.ts";
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

async function drain() {
  for (let i = 0; i < 30; i++) {
    if (!(await processEducationBatch()).length) break;
  }
}

Deno.test("教学通知：持久事件和反馈同事务，重复领取不重复，列表只保存定位而非私人摘要", async () => {
  const f = await fixture();
  const feedback = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "personal",
    { body: "secret private feedback", target_user_id: f.student },
  );
  const claimed = await claimEducationEvents();
  const event = claimed.find((row) => row.event_type === "notification")!;
  assertEquals(JSON.stringify(event.payload).includes("secret"), false);
  assertEquals(await processEducationEvent(event), true);
  assertEquals(await processEducationEvent(event), false);
  assertEquals((await f.db.select().from(educationNotifications)).length, 1);
  const listing = await listEducationNotifications(f.school.slug, f.student);
  assertEquals(listing.total, 1);
  assertEquals(listing.unread, 1);
  assertEquals(listing.data[0].feedback_id, feedback.id);
  assertEquals(JSON.stringify(listing).includes("secret"), false);
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.assistant)).total,
    0,
  );
  await assertRejects(
    () =>
      markEducationNotificationRead(
        f.other.slug,
        listing.data[0].id,
        f.student,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      markEducationNotificationRead(
        f.school.slug,
        listing.data[0].id,
        f.assistant,
      ),
    NotFoundError,
  );
  await markEducationNotificationRead(
    f.school.slug,
    listing.data[0].id,
    f.student,
  );
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).unread,
    0,
  );
  await updateAssignmentFeedback(
    f.school.slug,
    f.task.id,
    feedback.id,
    f.teacher,
    0,
    { withdraw: true },
  );
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.student)).total,
    0,
  );
});

Deno.test("教学通知：投递及读取重新检查助教能力，旧通知不能恢复求助访问", async () => {
  const f = await fixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["help:manage"] },
  );
  const help = await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.student,
    "help",
    { body: "secret help" },
  );
  await drain();
  const assistant = await listEducationNotifications(
    f.school.slug,
    f.assistant,
  );
  assertEquals(assistant.total, 1);
  assertEquals(assistant.data[0].help_id, help.id);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    3,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  assertEquals(
    (await listEducationNotifications(f.school.slug, f.assistant)).total,
    0,
  );
  await assertRejects(
    () =>
      markEducationNotificationRead(
        f.school.slug,
        assistant.data[0].id,
        f.assistant,
      ),
    NotFoundError,
  );
  await replyAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.teacher,
    "reply",
    { body: "secret explanation" },
  );
  await drain();
  const student = await listEducationNotifications(f.school.slug, f.student);
  assertEquals(student.total, 1);
  assertEquals(student.data[0].type, "help_reply");
  assertEquals(JSON.stringify(student).includes("secret"), false);
});

Deno.test("教学通知：业务事务回滚不留事件，投递前撤回反馈不产生通知", async () => {
  const f = await fixture();
  const countBefore = (await f.db.select().from(educationOutbox)).length;
  await assertRejects(() =>
    f.db.transaction(async (tx) => {
      await recordEducationNotice(tx, {
        domain_id: f.school.id,
        assignment_id: f.task.id,
        type: "assignment",
      });
      throw new Error("回滚");
    }), Error);
  assertEquals((await f.db.select().from(educationOutbox)).length, countBefore);
  const feedback = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "withdraw",
    { body: "撤回反馈", target_user_id: f.student },
  );
  await updateAssignmentFeedback(
    f.school.slug,
    f.task.id,
    feedback.id,
    f.teacher,
    0,
    { withdraw: true },
  );
  await drain();
  assertEquals(
    (await f.db.select().from(educationNotifications).where(
      eq(educationNotifications.assignment_id, f.task.id),
    )).length,
    0,
  );
});
