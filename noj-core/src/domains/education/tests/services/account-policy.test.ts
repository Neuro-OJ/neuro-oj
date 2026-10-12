import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import { assignments, userBans } from "../../../../shared/db/schema.ts";
import { banUser } from "../../../identity/index.ts";
import {
  consumeDomainInvitation,
  loadWorkspace,
} from "../../../workspace/index.ts";
import {
  createAssignment,
  createClassroomInvitation,
  getAssignment,
  getAssignmentMatrix,
  publishDueAssignments,
  scheduleAssignment,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("工作空间账号政策：全站封禁即时拒绝后台身份，社区封禁与过期封禁不阻止教学", async () => {
  const f = await assignmentFixture();
  await banUser(f.teacher, "全站封禁", null, "0");
  await assertRejects(
    () => loadWorkspace(f.school.slug, f.teacher),
    ForbiddenError,
  );
  await assertRejects(
    () => loadWorkspace("missing-school", f.teacher),
    ForbiddenError,
  );
  await banUser(f.teacher, "社区封禁", null, "0", "social");
  assertEquals(
    (await loadWorkspace(f.school.slug, f.teacher)).context.actorId,
    f.teacher,
  );
  await banUser(
    f.teacher,
    "临时封禁",
    new Date(Date.now() + 60000).toISOString(),
    "0",
  );
  await f.db.update(userBans).set({
    banned_until: new Date(Date.now() - 60000).toISOString(),
  }).where(eq(userBans.user_id, f.teacher));
  assertEquals(
    (await loadWorkspace(f.school.slug, f.teacher)).context.actorId,
    f.teacher,
  );
});

Deno.test("作业预约：保存实际预约人，不借创建者权限；封禁预约人后实际发布失败并回到草稿", async () => {
  const f = await assignmentFixture();
  const first = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const second = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.owner,
    f.input,
  );
  const date = new Date(Date.now() + 60000).toISOString();
  const byOwner = await scheduleAssignment(
    f.school.slug,
    first.id,
    f.owner,
    0,
    date,
  );
  const byTeacher = await scheduleAssignment(
    f.school.slug,
    second.id,
    f.teacher,
    0,
    date,
  );
  assertEquals(byOwner.scheduled_by, f.owner);
  assertEquals(byOwner.created_by, f.teacher);
  assertEquals(byTeacher.scheduled_by, f.teacher);
  assertEquals(byTeacher.created_by, f.owner);
  await banUser(f.teacher, "预约后封禁", null, "0");
  await f.db.update(assignments).set({
    publish_at: new Date(Date.now() - 1000).toISOString(),
  });
  const result = await publishDueAssignments();
  assertEquals(result.find((row) => row.id === first.id)?.published, true);
  assertEquals(result.find((row) => row.id === second.id)?.published, false);
  assertEquals(
    (await getAssignment(f.school.slug, first.id, f.owner)).state,
    "published",
  );
  const failed = await getAssignment(f.school.slug, second.id, f.owner);
  assertEquals(failed.state, "draft");
  assertEquals(failed.publish_error, "账号已被封禁");
  await assertRejects(
    () => getAssignmentMatrix(f.school.slug, first.id, f.teacher),
    ForbiddenError,
  );
});

Deno.test("班级邀请：已签发链接不能绕过目标账号全站封禁", async () => {
  const f = await assignmentFixture();
  const invitation = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `${f.assistant}@example.com`,
  );
  await banUser(f.assistant, "封禁目标账号", null, "0");
  await assertRejects(
    () => consumeDomainInvitation(invitation.token, f.assistant),
    ForbiddenError,
  );
});
