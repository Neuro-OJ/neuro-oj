import { setMemberRoles } from "../../../access/workspace/index.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  domainInvitations,
  domainMemberships,
  educationOperations,
  users,
} from "../../../../shared/db/schema.ts";
import { banUser } from "../../../access/identity/index.ts";
import { consumeDomainInvitation } from "../../../access/workspace/index.ts";
import {
  executeClassroomImport,
  previewClassroomImport,
  setClassroomMember,
} from "../../index.ts";
import { educationFixture } from "../_fixtures.ts";

Deno.test("批量入班：匹配本域账号、生成邀请、逐行错误和重复检查，不创建全站账号", async () => {
  const f = await educationFixture();
  const csv =
    `email,username\n${f.student}@example.com,${f.student}\n,${f.assistant}\nnew@example.com,\ninvalid,\n${f.student.toUpperCase()}@EXAMPLE.COM,`;
  const before = (await f.db.select({ id: users.id }).from(users)).length;
  const preview = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    csv,
  );
  assertEquals(preview.summary, {
    total: 5,
    join: 2,
    invite: 1,
    skipped: 0,
    errors: 2,
  });
  const result = await executeClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    "batch",
    0,
    { csv, preview_hash: preview.preview_hash },
  );
  assertEquals(result.summary, preview.summary);
  assertEquals(result.rows[2].token?.length, 72);
  assertEquals(result.replayed, false);
  assertEquals(
    (await f.db.select({ id: users.id }).from(users)).length,
    before,
  );
  const members = await f.db.select().from(classroomMemberships).where(
    eq(classroomMemberships.classroom_id, f.classroom.id),
  );
  assertEquals(members.filter((m) => m.role === "student").length, 2);
  const [stored] = await f.db.select().from(educationOperations);
  assertEquals(
    JSON.stringify(stored.result).includes(result.rows[2].token!),
    false,
  );
  const replay = await executeClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    "batch",
    0,
    { csv, preview_hash: preview.preview_hash },
  );
  assertEquals(replay.replayed, true);
  assertEquals(replay.rows[2].token, undefined);
  assertEquals((await f.db.select().from(domainInvitations)).length, 1);
  await banUser(f.owner, "封禁", null, "0");
  await assertRejects(
    () =>
      executeClassroomImport(
        f.school.slug,
        f.classroom.id,
        f.owner,
        "batch",
        0,
        { csv, preview_hash: preview.preview_hash },
      ),
    ForbiddenError,
  );
});

Deno.test("批量入班：预览后成员／账号事实变化回滚，不能调整教学人员或跨域复用", async () => {
  const f = await educationFixture(),
    csv = `email\n${f.student}@example.com\nnew@example.com`;
  const preview = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    csv,
  );
  await f.db.update(domainMemberships).set({ status: "removed" }).where(
    and(
      eq(domainMemberships.domain_id, f.school.id),
      eq(domainMemberships.user_id, f.student),
    ),
  );
  await assertRejects(
    () =>
      executeClassroomImport(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        "changed",
        0,
        { csv, preview_hash: preview.preview_hash },
      ),
    ConflictError,
  );
  assertEquals((await f.db.select().from(domainInvitations)).length, 0);
  await assertRejects(
    () => previewClassroomImport(f.other.slug, f.classroom.id, f.owner, csv),
    NotFoundError,
  );
  await assertRejects(
    () =>
      previewClassroomImport(f.school.slug, f.classroom.id, f.assistant, csv),
    NotFoundError,
  );
  const staff = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `username\n${f.teacher}`,
  );
  assertEquals(staff.rows[0].action, "join");
  const external = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    "email\nnew@example.com",
  );
  assertEquals(external.rows[0].action, "error");
});

Deno.test("批量邀请：重试只返回原记录，可显式预览重签并撤销旧链接", async () => {
  const f = await educationFixture(), csv = "email\ninvite@example.com";
  const preview = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    csv,
  );
  await assertRejects(
    () =>
      executeClassroomImport(f.school.slug, f.classroom.id, f.owner, "", 0, {
        csv,
        preview_hash: preview.preview_hash,
      }),
    BadRequestError,
  );
  const first = await executeClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    "first",
    0,
    { csv, preview_hash: preview.preview_hash },
  );
  const pending = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    csv,
  );
  assertEquals(pending.rows[0].action, "already_invited");
  const replacement = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    csv,
    true,
  );
  assertEquals(replacement.rows[0].action, "replace_invite");
  const second = await executeClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.owner,
    "replace",
    0,
    { csv, preview_hash: replacement.preview_hash, replace_pending: true },
  );
  assertEquals(second.rows[0].token !== first.rows[0].token, true);
  await assertRejects(
    () => consumeDomainInvitation(first.rows[0].token!, f.student),
    NotFoundError,
  );
  const old = await f.db.select().from(domainInvitations).where(
    eq(domainInvitations.id, first.rows[0].invitation_id!),
  );
  assertEquals(!!old[0].revoked_at, true);
});

Deno.test("批量入班：学生不可枚举账号，域教练只能接收本域成员、封禁目标及 40 人批次", async () => {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    0,
    { role: "student" },
  );
  await assertRejects(
    () =>
      previewClassroomImport(
        f.school.slug,
        f.classroom.id,
        f.student,
        "email\nany@example.com",
      ),
    ForbiddenError,
  );
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  await banUser(f.student, "目标封禁", null, "0");
  const blocked = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    `username\n${f.student}`,
  );
  assertEquals(blocked.rows[0].action, "error");
  const csv = "email\n" +
    Array.from({ length: 40 }, (_, i) => `student-${i}@example.com`).join("\n");
  const preview = await previewClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    csv,
  );
  const result = await executeClassroomImport(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    "40",
    1,
    { csv, preview_hash: preview.preview_hash },
  );
  assertEquals(result.summary.errors, 40);
  assertEquals((await f.db.select().from(domainInvitations)).length, 0);
});
