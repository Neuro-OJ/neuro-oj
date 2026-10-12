import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { count, eq } from "drizzle-orm";
import {
  disableTestTransactionForFile,
  getDb,
  resetDbForTest,
} from "../../../../shared/db/connection.ts";
import {
  domainInvitations,
  domainMemberships,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { registerUser } from "../../../identity/index.ts";
import { updateSetting } from "../../../system/index.ts";
import { createDomain, createDomainInvitation } from "../../index.ts";

// 验证真实事务，不让 preload 的外层事务掩盖跨连接读取死锁。
disableTestTransactionForFile();
await resetDbForTest();

Deno.test({
  name: "工作空间注册：邀请消费与账号创建原子，错误邀请不留下账号",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const now = new Date().toISOString();
    const operator = crypto.randomUUID();
    await getDb().insert(users).values({
      id: operator,
      username: "operator",
      email: "operator@example.com",
      created_at: now,
      updated_at: now,
    });
    const [admin] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({
      user_id: operator,
      role_id: admin.id,
    });
    const domain = await createDomain({
      slug: "registration-school",
      name: "学校",
      preset: "education",
    }, operator);
    const invitation = await createDomainInvitation(
      domain.slug,
      operator,
      "student@example.com",
    );
    await updateSetting("instance_registration_mode", "invite", operator);
    await assertRejects(
      () =>
        registerUser({
          username: "no_invite",
          email: "missing@example.com",
          password: "TestPass2026X",
          accepted_legal: true,
        }),
      ForbiddenError,
    );
    const [before] = await getDb().select({ count: count() }).from(users);
    await assertRejects(
      () =>
        registerUser({
          username: "wrong_email",
          email: "wrong@example.com",
          password: "TestPass2026X",
          accepted_legal: true,
          invitation_token: invitation.token,
        }),
      NotFoundError,
    );
    const [after] = await getDb().select({ count: count() }).from(users);
    assertEquals(after.count, before.count);
    const student = await registerUser({
      username: "invited_student",
      email: "student@example.com",
      password: "TestPass2026X",
      accepted_legal: true,
      invitation_token: invitation.token,
    });
    assertEquals(
      (await getDb().select().from(domainMemberships).where(
        eq(domainMemberships.user_id, student.id),
      )).some((row) => row.domain_id === domain.id),
      true,
    );
    assertEquals(
      (await getDb().select().from(domainInvitations).where(
        eq(domainInvitations.id, invitation.id),
      ))[0].used_at !== null,
      true,
    );
    await updateSetting("instance_registration_mode", "admin_only", operator);
    await assertRejects(
      () =>
        registerUser({
          username: "blocked_account",
          email: "blocked@example.com",
          password: "TestPass2026X",
          accepted_legal: true,
          invitation_token: invitation.token,
        }),
      ForbiddenError,
    );
  },
});
