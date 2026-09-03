import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";
import {
  permissions,
  rolePermissions,
  roles,
} from "./../../src/shared/db/schema.ts";
import { ensureRbacSeeds } from "../../src/domains/system/index.ts";

await resetDbForTest();

Deno.test({
  name: "rbac: training 权限默认授权",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await ensureRbacSeeds();

    const trainingDefs = await db
      .select()
      .from(permissions)
      .where(eq(permissions.resource, "training"));
    assertEquals(trainingDefs.length, 9);

    const [userRole] = await db
      .select()
      .from(roles)
      .where(eq(roles.name, "user"))
      .limit(1);
    const granted = await db
      .select({
        resource: permissions.resource,
        action: permissions.action,
      })
      .from(rolePermissions)
      .innerJoin(
        permissions,
        eq(rolePermissions.permission_id, permissions.id),
      )
      .where(eq(rolePermissions.role_id, userRole.id));

    const trainingGranted = granted
      .filter((p) => p.resource === "training")
      .map((p) => p.action)
      .sort();
    assertEquals(trainingGranted, [
      "create",
      "delete_own",
      "read",
      "write_own",
    ]);
    assertEquals(
      granted.some(
        (p) => p.resource === "training" && p.action === "publish",
      ),
      false,
    );
    assertEquals(
      granted.some((p) => p.resource === "training" && p.action === "pin"),
      false,
    );
  },
});
