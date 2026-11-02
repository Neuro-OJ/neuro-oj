/**
 * RBAC 种子批量写入语义测试（P3：Core reset 与种子批量写入）。
 *
 * 覆盖批量改写后必须保持的行为：空库初始化、重复 seed 幂等、描述同步但保留
 * 原 ID、描述未变不更新、自定义角色 ID 复用、已有角色的用户不补默认角色、
 * 敏感权限撤销只发生一次且不覆盖管理员显式授权、空集合不发无效 INSERT。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { unwrapRows } from "../../../../../shared/base/sql-rows.ts";
import {
  permissions,
  rolePermissions,
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { PERMISSION_DEFS } from "../../../../access/identity/types/permissions.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  ensureAdminRolePermissions,
  ensurePermissions,
  ensureRbacSeeds,
  ensureSensitiveFieldDefaultPermissions,
  ensureSystemRoles,
  ensureUserRolePermissions,
  migrateExistingUsers,
} from "../../services/seed/seed-rbac.ts";

/** NOJ-062 敏感字段撤销标记（内部键，不注册进 settings-registry）。 */
const SENSITIVE_REVOKE_MARKER = "rbac_sensitive_field_permissions_revoked";

/** 按 name 读取角色的真实 ID。 */
async function roleIdByName(name: string): Promise<string> {
  const [row] = await getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1);
  assert(row, "角色缺失：" + name);
  return row.id;
}

/** 按 resource/action 读取权限 ID。 */
async function permissionIdByKey(
  resource: string,
  action: string,
): Promise<string> {
  const [row] = await getDb()
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.resource, resource),
        eq(permissions.action, action),
      ),
    )
    .limit(1);
  assert(row, "权限缺失：" + resource + ":" + action);
  return row.id;
}

/** 角色是否持有指定权限。 */
async function hasRolePermission(
  roleId: string,
  permissionId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ role_id: rolePermissions.role_id })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role_id, roleId),
        eq(rolePermissions.permission_id, permissionId),
      ),
    );
  return rows.length > 0;
}

/** 插入一个满足非空约束的最小用户。 */
async function insertUser(id: string, suffix: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: "seed-rbac-" + suffix,
    email: "seed-rbac-" + suffix + "@example.test",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

/** 统计撤销标记行数。 */
async function markerCount(): Promise<number> {
  const rows = await getDb()
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, SENSITIVE_REVOKE_MARKER));
  return rows.length;
}

Deno.test({
  name: "seed-rbac: 空库初始化写入系统角色、全量权限与默认授权",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    const roleRows = await db.select().from(roles);
    assertEquals(roleRows.length, 2);
    const admin = roleRows.find((row) => row.name === "admin");
    const user = roleRows.find((row) => row.name === "user");
    assert(admin && user, "缺少系统角色");
    assertEquals(admin.is_system, true);
    assertEquals(admin.is_default, false);
    assertEquals(user.is_system, true);
    assertEquals(user.is_default, true);

    const permissionRows = await db.select({ id: permissions.id }).from(
      permissions,
    );
    assertEquals(permissionRows.length, PERMISSION_DEFS.length);

    assert(
      await hasRolePermission(
        admin.id,
        await permissionIdByKey(
          "admin",
          "full_access",
        ),
      ),
      "admin 角色必须持有 admin:full_access",
    );
    assert(
      await hasRolePermission(
        user.id,
        await permissionIdByKey(
          "problem",
          "create",
        ),
      ),
      "user 角色应持有 problem:create",
    );
    assert(
      await hasRolePermission(
        user.id,
        await permissionIdByKey(
          "submission",
          "create",
        ),
      ),
      "user 角色应持有 submission:create",
    );
    assert(
      !await hasRolePermission(
        user.id,
        await permissionIdByKey(
          "problem",
          "field_evaluator_command",
        ),
      ),
      "user 角色不得默认持有敏感字段权限",
    );
    assert(
      !await hasRolePermission(
        user.id,
        await permissionIdByKey(
          "problem",
          "field_evaluator_network",
        ),
      ),
      "user 角色不得默认持有敏感字段权限",
    );

    assertEquals(await markerCount(), 1);

    // 批量写入不得产生重复关联
    const links = await db.select().from(rolePermissions);
    const unique = new Set(
      links.map((row) => row.role_id + ":" + row.permission_id),
    );
    assertEquals(unique.size, links.length);
  },
});

Deno.test({
  name: "seed-rbac: 重复 seed 幂等（权限 ID、角色与关联集合不变）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    const readState = async () => ({
      permissions: await db
        .select({
          id: permissions.id,
          resource: permissions.resource,
          action: permissions.action,
        })
        .from(permissions)
        .orderBy(permissions.resource, permissions.action),
      roles: await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .orderBy(roles.name),
      linkCount: (await db.select().from(rolePermissions)).length,
      markerCount: await markerCount(),
    });

    const first = await readState();
    await ensureRbacSeeds();
    await ensureRbacSeeds();
    assertEquals(await readState(), first);
  },
});

Deno.test({
  name: "seed-rbac: 权限描述被改动后再次 seed 只同步描述并保留原 ID",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const targetId = await permissionIdByKey("problem", "create");
    const expected = PERMISSION_DEFS.find((def) =>
      def.resource === "problem" && def.action === "create"
    );
    assert(expected);

    await db.update(permissions).set({ description: "历史旧文案" }).where(
      eq(permissions.id, targetId),
    );
    await ensurePermissions();

    const rows = await db
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.resource, "problem"),
          eq(permissions.action, "create"),
        ),
      );
    assertEquals(rows.length, 1, "冲突键不得新增或复制行");
    assertEquals(rows[0].id, targetId, "冲突时保留原 ID");
    assertEquals(rows[0].description, expected.description);
  },
});

Deno.test({
  name: "seed-rbac: 权限描述未变化时不产生行更新",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const readRowVersion = async (): Promise<string> => {
      const result = await getDb().execute(sql`
        SELECT xmin::text AS xid
        FROM permissions
        WHERE resource = 'problem' AND action = 'create'
      `);
      const row = unwrapRows<{ xid: string }>(result as never)[0];
      assert(row, "缺少目标权限行");
      return row.xid;
    };

    const before = await readRowVersion();
    await ensurePermissions();
    assertEquals(
      await readRowVersion(),
      before,
      "描述未变化时 setWhere 应跳过更新（行版本不变）",
    );
  },
});

Deno.test({
  name: "seed-rbac: 已有同名角色使用自定义 ID 时按 name 复用真实 ID",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    // 模拟运维用随机 UUID 建过同名 user 角色（级联清理关联）
    await db.delete(roles);
    const customId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    await db.insert(roles).values({
      id: customId,
      name: "user",
      description: "运维自定义用户角色",
      is_system: false,
      is_default: false,
      parent_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    await ensureRbacSeeds();

    const userRolesRows = await db
      .select()
      .from(roles)
      .where(eq(roles.name, "user"));
    assertEquals(userRolesRows.length, 1, "同名角色不得重复插入");
    assertEquals(userRolesRows[0].id, customId);
    assertEquals(userRolesRows[0].description, "运维自定义用户角色");

    const legacyIdRows = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, "user"));
    assertEquals(legacyIdRows.length, 0, "不得再写入固定 id=user 的角色行");

    assert(
      await hasRolePermission(
        customId,
        await permissionIdByKey(
          "problem",
          "create",
        ),
      ),
      "默认权限必须挂到自定义角色 ID 上",
    );
    assert(
      await hasRolePermission(
        customId,
        await permissionIdByKey(
          "community",
          "comment",
        ),
      ),
      "默认权限必须挂到自定义角色 ID 上",
    );
    assert(
      await hasRolePermission(
        await roleIdByName("admin"),
        await permissionIdByKey("admin", "full_access"),
      ),
      "admin 角色仍按默认 id 创建并授权",
    );
  },
});

Deno.test({
  name: "seed-rbac: 已有任意角色的用户不补默认角色，无角色用户才补",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const stamp = Date.now().toString(36);
    const withRole = crypto.randomUUID();
    const withoutRole = crypto.randomUUID();
    await insertUser(withRole, "with-role-" + stamp);
    await insertUser(withoutRole, "no-role-" + stamp);

    const adminRoleId = await roleIdByName("admin");
    await db.insert(userRoles).values({
      user_id: withRole,
      role_id: adminRoleId,
    });

    await migrateExistingUsers();

    const withRoleRows = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.user_id, withRole));
    assertEquals(withRoleRows.length, 1, "已有角色的用户不得被追加默认角色");
    assertEquals(withRoleRows[0].role_id, adminRoleId);

    const withoutRoleRows = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.user_id, withoutRole));
    assertEquals(withoutRoleRows.length, 1, "无角色用户应补默认 user 角色");
    assertEquals(withoutRoleRows[0].role_id, await roleIdByName("user"));

    await migrateExistingUsers();
    assertEquals(
      (await db.select().from(userRoles).where(eq(userRoles.user_id, withRole)))
        .length,
      1,
      "重复执行保持幂等",
    );
  },
});

Deno.test({
  name: "seed-rbac: 敏感权限撤销标记存在时保留管理员后续显式授权",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const userRoleId = await roleIdByName("user");
    const sensitiveId = await permissionIdByKey(
      "problem",
      "field_evaluator_command",
    );
    assertEquals(await markerCount(), 1, "初始化后应已写入撤销标记");

    await db.insert(rolePermissions).values({
      role_id: userRoleId,
      permission_id: sensitiveId,
    });

    await ensureRbacSeeds();

    assert(
      await hasRolePermission(userRoleId, sensitiveId),
      "标记存在时不得再次撤销管理员的显式授权",
    );
  },
});

Deno.test({
  name: "seed-rbac: 敏感权限首次撤销一次集合 delete 并写入标记",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const userRoleId = await roleIdByName("user");
    const sensitiveIds = [
      await permissionIdByKey("problem", "field_evaluator_command"),
      await permissionIdByKey("problem", "field_evaluator_network"),
    ];

    // 模拟升级前状态：标记缺失且 user 角色仍持有两个敏感权限
    await db.delete(systemSettings).where(
      eq(systemSettings.key, SENSITIVE_REVOKE_MARKER),
    );
    await db.insert(rolePermissions).values(
      sensitiveIds.map((permissionId) => ({
        role_id: userRoleId,
        permission_id: permissionId,
      })),
    );

    await ensureSensitiveFieldDefaultPermissions();

    for (const permissionId of sensitiveIds) {
      assert(
        !await hasRolePermission(userRoleId, permissionId),
        "首次撤销应一次清掉集合内的全部敏感权限",
      );
    }
    assertEquals(await markerCount(), 1, "撤销后应写入标记");

    // 管理员随后显式授权：标记存在时再次执行不会撤销
    await db.insert(rolePermissions).values({
      role_id: userRoleId,
      permission_id: sensitiveIds[0],
    });
    await ensureSensitiveFieldDefaultPermissions();
    assert(await hasRolePermission(userRoleId, sensitiveIds[0]));
  },
});

Deno.test({
  name: "seed-rbac: 角色或权限缺失时不发无效 INSERT",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    // 权限缺失：角色存在，批量授权应静默跳过
    await db.delete(rolePermissions);
    await db.delete(permissions);
    await ensureUserRolePermissions();
    await ensureAdminRolePermissions();
    assertEquals((await db.select().from(permissions)).length, 0);
    assertEquals((await db.select().from(rolePermissions)).length, 0);

    // 角色缺失：所有种子函数都应安全返回
    await db.delete(roles);
    await ensureUserRolePermissions();
    await ensureAdminRolePermissions();
    await ensureSensitiveFieldDefaultPermissions();
    await migrateExistingUsers();
    assertEquals((await db.select().from(roles)).length, 0);
    assertEquals((await db.select().from(rolePermissions)).length, 0);

    // 重新创建角色时没有权限可授，也不得抛错
    await ensureSystemRoles();
    assertEquals((await db.select().from(roles)).length, 2);
    assertEquals((await db.select().from(rolePermissions)).length, 0);
  },
});

Deno.test({
  name: "seed-rbac: 权限定义键唯一（批量 upsert 不能重复影响同一行）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const keys = PERMISSION_DEFS.map((def) => def.resource + ":" + def.action);
    assertEquals(
      new Set(keys).size,
      keys.length,
      "PERMISSION_DEFS 存在重复 (resource, action)：批量 ON CONFLICT DO UPDATE 会报错",
    );
  },
});
