import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainMemberRoles,
  domainMemberships,
  domains,
  users,
} from "../../../../shared/db/schema.ts";
import { presetConfiguration } from "../../types.ts";

await resetDbForTest();

Deno.test({
  name: "工作空间数据库：成员唯一、非法角色和负责人删除均受约束",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const owner = crypto.randomUUID();
    const domainId = crypto.randomUUID();
    await db.insert(users).values({
      id: owner,
      username: owner,
      email: `${owner}@example.com`,
      created_at: now,
      updated_at: now,
    });
    await db.insert(domains).values({
      id: domainId,
      slug: `test-${domainId.slice(0, 8)}`,
      name: "测试班级",
      owner_id: owner,
      preset: "education",
      configuration: presetConfiguration("education"),
      created_at: now,
      updated_at: now,
    });
    const membership = {
      id: crypto.randomUUID(),
      domain_id: domainId,
      user_id: owner,
      joined_at: now,
    };
    await db.insert(domainMemberships).values(membership);
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.insert(domainMemberships).values({
          ...membership,
          id: crypto.randomUUID(),
        })
      )
    );
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.execute(
          sql`INSERT INTO domain_member_roles (membership_id, role) VALUES (${membership.id}, 'admin:full_access')`,
        )
      )
    );
    await db.insert(domainMemberRoles).values({
      membership_id: membership.id,
      role: "owner",
    });
    await assertRejects(() =>
      db.transaction((tx) => tx.delete(users).where(eq(users.id, owner)))
    );
    assertEquals(
      (await db.select().from(domainMemberRoles).where(
        eq(domainMemberRoles.membership_id, membership.id),
      ))[0].role,
      "owner",
    );
  },
});
