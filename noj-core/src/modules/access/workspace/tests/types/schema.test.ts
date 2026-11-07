import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  domainMemberships,
  domains,
  users,
} from "../../../../../shared/db/schema.ts";
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
      role: "member" as const,
      joined_at: now,
    };
    await db.insert(domainMemberships).values(membership);
    // 同一用户在同一域只能有一条成员记录。
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.insert(domainMemberships).values({
          ...membership,
          id: crypto.randomUUID(),
        })
      )
    );
    // owner 不写入成员角色列；平台/任意字符串也不能变成域角色。
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.execute(
          sql`UPDATE domain_memberships SET role = 'owner' WHERE id = ${membership.id}`,
        )
      )
    );
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.execute(
          sql`UPDATE domain_memberships SET role = 'admin:full_access' WHERE id = ${membership.id}`,
        )
      )
    );
    // 平台角色同样只接受 user/admin。
    await assertRejects(() =>
      db.transaction((tx) =>
        tx.execute(
          sql`UPDATE users SET role = 'root' WHERE id = ${owner}`,
        )
      )
    );
    await db.update(domainMemberships).set({ role: "admin" }).where(
      eq(domainMemberships.id, membership.id),
    );
    // 负责人仍受 domains.owner_id 外键保护，不能直接删除用户行。
    await assertRejects(() =>
      db.transaction((tx) => tx.delete(users).where(eq(users.id, owner)))
    );
    assertEquals(
      (await db.select().from(domainMemberships).where(
        eq(domainMemberships.id, membership.id),
      ))[0].role,
      "admin",
    );
  },
});
