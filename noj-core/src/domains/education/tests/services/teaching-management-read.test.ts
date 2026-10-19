import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createAssignment,
  getAssignment,
  getClassroom,
  listClassroomMembers,
  publishAssignment,
  removeClassroomMember,
  transferClassroom,
} from "../../index.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { setMemberRole } from "../../../workspace/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学管理读取：域教练可选择所有班级学生，名册不包含教学角色或授权数组", async () => {
  const f = await assignmentFixture();
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  const roster = await listClassroomMembers(f.school.slug, f.classroom.id, f.assistant);
  assertEquals(roster.map(member => member.user_id), [f.student]);
  assertEquals(roster.every(member => member.role === "student" && !("capabilities" in member)), true);
  const managerRoster = await listClassroomMembers(f.school.slug, f.classroom.id, f.teacher);
  assertEquals(managerRoster.every(member => !("capabilities" in member)), true);
  assertEquals((await listClassroomMembers(f.school.slug, f.classroom.id, f.student)).map(member => member.user_id), [f.student]);
  await setMemberRole(f.school.slug, f.owner, f.assistant, "member");
  await assertRejects(() => listClassroomMembers(f.school.slug, f.classroom.id, f.assistant), NotFoundError);
});

Deno.test("教学管理读取：离班学生保留历史，联系人变化不撤职，域角色降级立即失权", async () => {
  const f = await assignmentFixture();
  await removeClassroomMember(f.school.slug, f.classroom.id, f.teacher, f.student, 1);
  const room = await getClassroom(f.school.slug, f.classroom.id, f.student);
  assertEquals(room.membership, null);
  assertEquals(room.historical_student, true);
  assertEquals("capabilities" in room, false);
  assertEquals(room.manages_domain, false);
  await transferClassroom(f.school.slug, f.classroom.id, f.owner, f.owner, 2);
  assertEquals((await getClassroom(f.school.slug, f.classroom.id, f.teacher)).manages_domain, true);
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  await assertRejects(() => getClassroom(f.school.slug, f.classroom.id, f.teacher), NotFoundError);
  await assertRejects(() => getClassroom(f.other.slug, f.classroom.id, f.student), NotFoundError);
});

Deno.test("教学管理读取：教练无需班级任职，学生目录只返回学生而非所有域成员", async () => {
  const f = await assignmentFixture();
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  const roster = await listClassroomMembers(f.school.slug, f.classroom.id, f.assistant);
  assertEquals(roster.map(member => member.user_id), [f.student]);
  const room = await getClassroom(f.school.slug, f.classroom.id, f.assistant);
  assertEquals(room.membership, null);
  assertEquals(room.manages_domain, true);
  assertEquals("capabilities" in room, false);
});

Deno.test("作业管理读取：来源题号及发布依据可读，学生 DTO 不附带其他目标学生或源题内容", async () => {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const preview = await getAssignment(f.school.slug, draft.id, f.teacher);
  assertEquals(preview.items[0].reference.display_ref, "1001");
  assertEquals(
    preview.items[0].reference.qualified_ref,
    `${f.school.slug}:1001`,
  );
  await assertRejects(
    () => getAssignment(f.school.slug, draft.id, f.student),
    NotFoundError,
  );
  await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "publish");
  const own = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals(own.items[0].reference.display_ref, "1001");
  assertEquals("target_student_ids" in own, false);
  assertEquals("content" in own.items[0], false);
  assertEquals("problem" in own.items[0], false);
});
