import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import {
  classroomMemberships,
  domainInvitations,
  domainMemberships,
} from "../../../shared/db/schema.ts";
import {
  consumeDomainInvitationCommand,
  createClassroomInvitationCommand,
} from "../../application/index.ts";
import { userActorFromAuthenticatedId } from "../contracts/actor.ts";
import { account, educationFixture } from "../../education/tests/_fixtures.ts";

Deno.test({
  name: "application access：班级邀请在同一事务内写入域成员和学生任职",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await educationFixture();
    const recipient = await account();
    const invitation = await createClassroomInvitationCommand(
      userActorFromAuthenticatedId(fixture.owner),
      fixture.school.slug,
      fixture.classroom.id,
      `${recipient}@example.com`,
    );

    const [stored] = await fixture.db.select().from(domainInvitations).where(
      eq(domainInvitations.id, invitation.id),
    );
    assertEquals(stored.classroom_id, fixture.classroom.id);
    assertEquals(stored.token_hash === invitation.token, false);

    const accepted = await consumeDomainInvitationCommand(
      userActorFromAuthenticatedId(recipient),
      invitation.token,
    );
    assertEquals(accepted.domain_id, fixture.school.id);
    assertEquals(accepted.classroom_id, fixture.classroom.id);

    const [domainMember] = await fixture.db.select().from(domainMemberships)
      .where(and(
        eq(domainMemberships.domain_id, fixture.school.id),
        eq(domainMemberships.user_id, recipient),
      ));
    assertEquals(domainMember.status, "active");

    const [classroomMember] = await fixture.db.select().from(
      classroomMemberships,
    ).where(and(
      eq(classroomMemberships.classroom_id, fixture.classroom.id),
      eq(classroomMemberships.user_id, recipient),
    ));
    assertEquals(classroomMember.role, "student");
    assertEquals(classroomMember.status, "active");
  },
});

Deno.test({
  name:
    "application access：班级成员写入失败回滚域成员和邀请使用次数，恢复后可重试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await educationFixture();
    const recipient = await account();
    const actor = userActorFromAuthenticatedId(recipient);
    const invitation = await createClassroomInvitationCommand(
      userActorFromAuthenticatedId(fixture.owner),
      fixture.school.slug,
      fixture.classroom.id,
      `${recipient}@example.com`,
    );
    // 真实 PostgreSQL 在跨模块第二步失败，不能用同一根连接方法的 mock 伪装事务。
    const constraint = `test_classroom_atomic_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    await fixture.db.execute(sql.raw(
      `ALTER TABLE classroom_memberships ADD CONSTRAINT "${constraint}" CHECK (FALSE) NOT VALID`,
    ));
    try {
      const error = await assertRejects(() =>
        consumeDomainInvitationCommand(actor, invitation.token)
      );
      const messages: string[] = [];
      for (
        let cause: unknown = error;
        cause instanceof Error;
        cause = cause.cause
      ) messages.push(cause.message);
      assertStringIncludes(messages.join("\n"), constraint);
      assertEquals(
        await fixture.db.select().from(domainMemberships).where(and(
          eq(domainMemberships.domain_id, fixture.school.id),
          eq(domainMemberships.user_id, recipient),
        )),
        [],
      );
      assertEquals(
        await fixture.db.select().from(classroomMemberships).where(and(
          eq(classroomMemberships.classroom_id, fixture.classroom.id),
          eq(classroomMemberships.user_id, recipient),
        )),
        [],
      );
      const [stored] = await fixture.db.select().from(domainInvitations).where(
        eq(domainInvitations.id, invitation.id),
      );
      assertEquals(stored.used_count, 0);
      assertEquals(stored.used_at, null);
    } finally {
      await fixture.db.execute(
        sql.raw(
          `ALTER TABLE classroom_memberships DROP CONSTRAINT "${constraint}"`,
        ),
      );
    }
    await consumeDomainInvitationCommand(actor, invitation.token);
    const [stored] = await fixture.db.select().from(domainInvitations).where(
      eq(domainInvitations.id, invitation.id),
    );
    assertEquals(stored.used_count, 1);
  },
});
