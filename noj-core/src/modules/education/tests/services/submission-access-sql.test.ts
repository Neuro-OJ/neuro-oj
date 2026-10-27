import { setMemberRoles } from "../../../access/workspace/index.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import {
  currentTeacherSubmissionAccessWhere,
  removeClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教师提交 SQL：同域当前域级教练，离班和撤权实时失效", async () => {
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
  assertEquals(await allowed(f.assistant), false);
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  assertEquals(await allowed(f.assistant), true);
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["member"]);
  assertEquals(await allowed(f.assistant), false);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  assertEquals(await allowed(f.teacher), false);
});
