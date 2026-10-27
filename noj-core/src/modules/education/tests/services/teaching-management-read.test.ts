import { setMemberRoles } from "../../../access/workspace/index.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createAssignment,
  getAssignment,
  getClassroom,
  listClassroomMembers,
  publishAssignment,
  removeClassroomMember,
} from "../../index.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学管理读取：域教练读取全部学生，学生仅能读取自身成员记录", async () => {
  const f = await assignmentFixture();
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  const roster = await listClassroomMembers(
    f.school.slug,
    f.classroom.id,
    f.assistant,
  );
  assertEquals(roster.map((m) => m.user_id), [f.student]);
  assertEquals(roster.every((m) => !("capabilities" in m)), true);
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, f.student)).map((
      m,
    ) => m.user_id),
    [f.student],
  );
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["member"]);
  await assertRejects(
    () => listClassroomMembers(f.school.slug, f.classroom.id, f.assistant),
    NotFoundError,
  );
});

Deno.test("教学管理读取：离班学生可读取历史班级但没有当前身份，离职教师仍不可访问", async () => {
  const f = await assignmentFixture();
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  const room = await getClassroom(f.school.slug, f.classroom.id, f.student);
  assertEquals(room.membership, null);
  assertEquals(room.historical_student, true);
  assertEquals(room.capabilities, []);
  assertEquals(room.manages_domain, false);
  await setMemberRoles(f.school.slug, f.owner, f.teacher, ["member"]);
  await assertRejects(
    () => getClassroom(f.school.slug, f.classroom.id, f.teacher),
    NotFoundError,
  );
  await assertRejects(
    () => getClassroom(f.other.slug, f.classroom.id, f.student),
    NotFoundError,
  );
});

Deno.test("教学管理读取：域教练无需班级任职即可取得完整教学能力", async () => {
  const f = await assignmentFixture();
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  const room = await getClassroom(f.school.slug, f.classroom.id, f.assistant);
  assertEquals(room.membership, null);
  assertEquals(room.manages_domain, true);
  assertEquals(room.capabilities.includes("submissions:read"), true);
  assertEquals(room.capabilities.includes("students:manage"), true);
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
