/**
 * resetDbForTest 语义与所有权防护测试（P3：Core reset 与种子批量写入）。
 *
 * 覆盖：普通 reset 的完整清表 + 种子恢复、带榜单刷新的 reset、错误 ownership
 * 标记与数据库名不一致时的拒绝（且不改动数据）、系统设置缓存仍走既有 reset
 * 接口、以及 NOJ_TEST_RESET_STRATEGY=truncate 的旧路径兜底。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";
import { ROOT_USER_ID } from "../../src/shared/base/constants.ts";
import {
  judgeImages,
  permissions,
  roles,
  systemSettings,
  tags,
  users,
} from "../../src/shared/db/schema.ts";
import { PERMISSION_DEFS } from "../../src/modules/access/identity/types/permissions.ts";
import {
  getSetting,
  initSystemSettings,
} from "../../src/modules/platform/system/services/system-settings.ts";
import { resetDbForTest } from "../helpers/db.ts";

const SENSITIVE_REVOKE_MARKER = "rbac_sensitive_field_permissions_revoked";

/** 生成带唯一后缀的标签，便于断言"被清掉了"。 */
async function insertMarkerTag(suffix: string): Promise<string> {
  const timestamp = new Date().toISOString();
  const name = "reset-db-marker-" + suffix;
  await getDb().insert(tags).values({
    id: "tag-reset-db-" + suffix,
    name,
    kind: "problem",
    created_at: timestamp,
    updated_at: timestamp,
  });
  return name;
}

/** 统计标签行数。 */
async function countTag(name: string): Promise<number> {
  const rows = await getDb()
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, name));
  return rows.length;
}

Deno.test({
  name: "reset-db: 普通 reset 清空业务数据并恢复种子",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const stamp = Date.now().toString(36);
    const timestamp = new Date().toISOString();

    await db.insert(users).values({
      id: crypto.randomUUID(),
      username: "reset-db-user-" + stamp,
      email: "reset-db-user-" + stamp + "@example.test",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const markerTag = await insertMarkerTag(stamp);
    assertEquals(await countTag(markerTag), 1);

    await resetDbForTest();

    const userRows = await db.select({ id: users.id }).from(users);
    assertEquals(userRows.length, 1, "reset 后只应保留 root 用户");
    assertEquals(userRows[0].id, ROOT_USER_ID);
    assertEquals(await countTag(markerTag), 0, "reset 必须清空业务数据");

    const roleRows = await db.select({ name: roles.name }).from(roles);
    assertEquals(
      roleRows.map((row) => row.name).sort(),
      ["admin", "user"],
      "reset 后应恢复两条系统角色",
    );
    assertEquals(
      (await db.select({ id: permissions.id }).from(permissions)).length,
      PERMISSION_DEFS.length,
      "reset 后应恢复全量权限定义",
    );

    const imageRows = await db.select({ id: judgeImages.id }).from(judgeImages);
    assertEquals(imageRows.length, 4, "reset 后应恢复三条兼容镜像 + AI 镜像");
    const imageIds = imageRows.map((row) => row.id).sort();
    assertEquals(imageIds, [
      "e0000000-0000-0000-0000-000000000001",
      "e0000000-0000-0000-0000-000000000002",
      "e0000000-0000-0000-0000-000000000003",
      "e0000000-0000-0000-0000-000000000004",
    ]);

    const markerRows = await db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(eq(systemSettings.key, SENSITIVE_REVOKE_MARKER));
    assertEquals(markerRows.length, 1, "reset 后应恢复敏感权限撤销标记");
  },
});

Deno.test({
  name: "reset-db: 带榜单刷新的 reset 成功且物化视图可查询",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest({ refreshRankings: true });

    const viewResult = await getDb().execute(
      sql`SELECT to_regclass('user_rankings') AS name`,
    );
    const view = unwrapRows<{ name: string | null }>(viewResult as never)[0];
    assert(view && view.name, "排行榜物化视图应存在于迁移后的 schema");

    const countResult = await getDb().execute(
      sql`SELECT count(*)::int AS count FROM user_rankings`,
    );
    const count = unwrapRows<{ count: number }>(countResult as never)[0];
    assert(count, "刷新后应能查询排行榜视图");
    assertEquals(typeof count.count, "number");
  },
});

Deno.test({
  name: "reset-db: 错误 ownership 标记或库名不一致时拒绝且不改动数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const stamp = Date.now().toString(36);
    const markerTag = await insertMarkerTag(stamp);

    const owned = Deno.env.get("NOJ_TEST_DATABASE_OWNED");
    Deno.env.set("NOJ_TEST_DATABASE_OWNED", "0");
    try {
      await assertRejects(
        () => resetDbForTest(),
        Error,
        "NOJ_TEST_DATABASE_OWNED",
      );
    } finally {
      if (owned === undefined) Deno.env.delete("NOJ_TEST_DATABASE_OWNED");
      else Deno.env.set("NOJ_TEST_DATABASE_OWNED", owned);
    }
    assertEquals(await countTag(markerTag), 1, "拒绝后不得清空数据");

    const declaredName = Deno.env.get("NOJ_TEST_DATABASE_NAME");
    assert(declaredName, "启动器必须提供 NOJ_TEST_DATABASE_NAME");
    Deno.env.set("NOJ_TEST_DATABASE_NAME", declaredName + "_other");
    try {
      await assertRejects(() => resetDbForTest(), Error, "不一致");
    } finally {
      Deno.env.set("NOJ_TEST_DATABASE_NAME", declaredName);
    }
    assertEquals(await countTag(markerTag), 1, "拒绝后不得清空数据");
  },
});

Deno.test({
  name: "reset-db: 系统设置缓存仍由既有 reset 接口清理",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const timestamp = new Date().toISOString();
    await getDb().insert(systemSettings).values({
      key: "legal_operator_name",
      value: JSON.stringify("stale-cache-marker"),
      description: "",
      is_secret: false,
      updated_at: timestamp,
      updated_by: ROOT_USER_ID,
    });
    await initSystemSettings();
    assertEquals(
      getSetting("legal_operator_name")?.value,
      "stale-cache-marker",
      "缓存应装载 DB 中的值",
    );

    await resetDbForTest();

    assertEquals(
      getSetting("legal_operator_name")?.value,
      "",
      "reset 必须同时清空 DB 行与进程内设置缓存，不能读到旧缓存",
    );
  },
});

Deno.test({
  name: "reset-db: NOJ_TEST_RESET_STRATEGY=truncate 时旧路径仍清空数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const previous = Deno.env.get("NOJ_TEST_RESET_STRATEGY");
    Deno.env.set("NOJ_TEST_RESET_STRATEGY", "truncate");
    try {
      await resetDbForTest();
      const stamp = Date.now().toString(36);
      const markerTag = await insertMarkerTag(stamp);
      assertEquals(await countTag(markerTag), 1);

      await resetDbForTest();

      assertEquals(
        await countTag(markerTag),
        0,
        "TRUNCATE 路径同样必须清空数据",
      );
      assertEquals(
        (await getDb().select({ id: roles.id }).from(roles)).length,
        2,
        "TRUNCATE 路径同样必须恢复种子",
      );
    } finally {
      if (previous === undefined) Deno.env.delete("NOJ_TEST_RESET_STRATEGY");
      else Deno.env.set("NOJ_TEST_RESET_STRATEGY", previous);
    }
  },
});
