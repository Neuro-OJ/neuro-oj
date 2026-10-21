import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import {
  currentTeacherSubmissionAccessWhere,
  removeClassroomMember,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教师提交 SQL：同域当前教练与单独助教能力，离班和撤权实时失效", async () => {
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
  assertEquals(await allowed(f.teacher, f.other.id), false);
  assertEquals(await allowed(f.student), false);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  assertEquals(await allowed(f.assistant), false);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["submissions:read"] },
  );
  assertEquals(await allowed(f.assistant), true);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    3,
    { role: "assistant", capabilities: [] },
  );
  assertEquals(await allowed(f.assistant), false);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    4,
  );
  assertEquals(await allowed(f.teacher), false);
});
