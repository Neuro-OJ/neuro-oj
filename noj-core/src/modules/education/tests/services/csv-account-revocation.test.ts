import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  domainMemberRoles,
  domainMemberships,
  users,
} from "../../../../shared/db/schema.ts";
import { banUser } from "../../../access/identity/index.ts";
import {
  createAssignment,
  exportAssignmentMatrixCsv,
  publishAssignment,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("CSV 分页：初始认证通过后全站封禁，下一页仍即时拒绝，不依赖旧 HTTP 会话", async () => {
  const f = await assignmentFixture(), now = new Date().toISOString();
  const extra = Array.from(
    { length: 50 },
    () => ({ id: crypto.randomUUID(), membershipId: crypto.randomUUID() }),
  );
  await f.db.insert(users).values(
    extra.map((user) => ({
      id: user.id,
      username: user.id,
      email: `${user.id}@example.com`,
      created_at: now,
      updated_at: now,
    })),
  );
  await f.db.insert(domainMemberships).values(
    extra.map((user) => ({
      id: user.membershipId,
      domain_id: f.school.id,
      user_id: user.id,
      joined_at: now,
    })),
  );
  await f.db.insert(domainMemberRoles).values(
    extra.map((user) => ({
      membership_id: user.membershipId,
      role: "member" as const,
    })),
  );
  await f.db.insert(classroomMemberships).values(
    extra.map((user) => ({
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      classroom_id: f.classroom.id,
      user_id: user.id,
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
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const iterator = await exportAssignmentMatrixCsv(
    f.school.slug,
    task.id,
    f.teacher,
  );
  assertEquals((await iterator.next()).done, false);
  assertEquals((await iterator.next()).done, false);
  await banUser(f.teacher, "导出期间封禁", null, "0");
  await assertRejects(() => iterator.next(), ForbiddenError);
});
