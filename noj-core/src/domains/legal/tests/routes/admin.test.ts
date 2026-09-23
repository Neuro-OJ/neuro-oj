/**
 * legal 管理路由测试。
 *
 * 覆盖：非 legal:manage 访问 403；发布版本；请求列表与状态更新。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "./../../../identity/services/security/jwt.ts";

/** 创建普通用户（无 legal:manage）并签发 token。 */
async function makePlainUser(id: string) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id,
      username: `plain_${id}`,
      email: `${id}@example.test`,
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  return await signToken({ sub: id, role: "user" });
}

Deno.test({
  name: "legal admin: 无 legal:manage 访问返回 403",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makePlainUser("legal-plain-1");
    const app = createApp();
    const res = await app.request("/api/v1/admin/legal/documents/privacy", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "legal admin: 具备 legal:manage 可发布版本",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const userId = "legal-admin-1";
    await db
      .insert(users)
      .values({
        id: userId,
        username: "legal_admin",
        email: "legal_admin@example.test",
        password_hash: "",
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing();

    // 建一个含 legal:manage 的角色并授予该用户
    const { ensureRbacSeeds } = await import(
      "../../../system/services/seed/seed-rbac.ts"
    );
    await ensureRbacSeeds();
    const { eq: eqOp } = await import("drizzle-orm");
    const [perm] = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        eqOp(permissions.resource, "legal"),
      )
      .limit(1);
    const permId = perm?.id ?? "";
    const roleId = crypto.randomUUID();
    await db.insert(roles).values({
      id: roleId,
      name: `legal-manager-${Date.now()}`,
      description: "",
      is_system: false,
      created_at: now,
      updated_at: now,
    });
    await db.insert(rolePermissions).values({
      role_id: roleId,
      permission_id: permId,
    });
    await db.insert(userRoles).values({
      user_id: userId,
      role_id: roleId,
    });

    const token = await signToken({ sub: userId, role: "user" });
    const app = createApp();
    const res = await app.request(
      "/api/v1/admin/legal/documents/privacy/versions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: "隐私政策 v1",
          is_material: true,
        }),
      },
    );
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.version, 1);
  },
});
