import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { setMemberRole } from "../../../workspace/index.ts";
import { sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import {
  currentTeacherSubmissionAccessWhere,
  removeClassroomMember,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教师提交 SQL：权限来自现任域教练，学生离班不撤教师权限，降级立即失效", async () => {
  const f = await assignmentFixture();
  const allowed = async (actor: string, domain = f.school.id) =>
    unwrapRows<{ allowed: boolean }>(
      await f.db.execute(
        sql`SELECT ${
          currentTeacherSubmissionAccessWhere(f.student, domain, actor)
        } AS allowed`,
      ) as never,
    )[0].allowed;
  assertEquals(await allowed(f.teacher), true);
  assertEquals(await allowed(f.owner), true);
  assertEquals(await allowed(f.teacher, f.other.id), false);
  assertEquals(await allowed(f.student), false);
  await assertRejects(() =>
    setClassroomMember(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      f.assistant,
      1,
      { role: "assistant", capabilities: ["progress:read"] },
    ), BadRequestError);
  assertEquals(await allowed(f.assistant), false);
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  assertEquals(await allowed(f.assistant), true);
  await setMemberRole(f.school.slug, f.owner, f.assistant, "member");
  assertEquals(await allowed(f.assistant), false);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  assertEquals(await allowed(f.teacher), true);
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  assertEquals(await allowed(f.teacher), false);
});
