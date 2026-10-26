/**
 * 测试启动器的真实 PostgreSQL 迁移路径回归。
 *
 * 普通 child 已由启动器从正式模板克隆，本文件先用 helper 确认当前进程确实
 * 连接到本 run 的数据库，再在同一专用 PostgreSQL server 上创建本测试独占的
 * 临时数据库。临时库只通过正式 journal/SQL 和 Drizzle 官方 PgDialect migrator
 * 建立，不调用生产 migrate，也不使用手写 DDL；finally 只删除本文件生成的库。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  type MigrationConfig,
  type MigrationMeta,
  readMigrationFiles,
} from "drizzle-orm/migrator";
import postgres from "postgres";
import {
  assertDatabaseIdentifier,
  databaseUrlFor,
  isOwnedDatabaseName,
} from "../../scripts/test-launcher-resources.ts";
import { assertOwnedTestDatabase } from "../helpers/db.ts";

const MIGRATIONS_DIR = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../drizzle",
);
const MIGRATION_CONFIG: MigrationConfig = {
  migrationsFolder: MIGRATIONS_DIR,
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

type PgClient = ReturnType<typeof postgres>;
type LedgerRow = { hash: string; created_at: string };
type PgMigrationSession = Parameters<PgDialect["migrate"]>[1];

const ROOT_ID = "0";
const LEGACY_USER_ID = "00000000-0000-4000-8000-000000000901";
const DOMAIN_ID = "00000000-0000-4000-8000-000000000902";
const PENDING_INVITATION_ID = "00000000-0000-4000-8000-000000000903";
const USED_INVITATION_ID = "00000000-0000-4000-8000-000000000904";
const GENERAL_INVITATION_ID = "00000000-0000-4000-8000-000000000905";
const REDEEMED_AT = "2025-01-02T03:04:05.000Z";
const EXPIRES_AT = "2099-01-02T03:04:05.000Z";

function adminUrlForCurrentDatabase(): string {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL 未设置：迁移升级集成测试必须连接真实 PostgreSQL",
    );
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  return adminUrl.toString();
}

function migrationConfigFor(folder: string): MigrationConfig {
  return { ...MIGRATION_CONFIG, migrationsFolder: folder };
}

function openClient(databaseUrl: string): PgClient {
  return postgres(databaseUrl, { max: 1 });
}

function migrationSession(client: PgClient): PgMigrationSession {
  // 无 schema 的 migrator 只需要 PgSession；drizzlePg 的公开推导会保留
  // `ExtractTablesWithRelations`，这里按 Drizzle 官方 PgDialect 参数收窄。
  return drizzlePg(client)._.session as unknown as PgMigrationSession;
}

async function migrateWithAssets(
  client: PgClient,
  folder: string,
): Promise<MigrationMeta[]> {
  const config = migrationConfigFor(folder);
  // readMigrationFiles 是 Drizzle 官方 migrator 使用的 journal/SQL 读取入口。
  const migrations = readMigrationFiles(config);
  await new PgDialect().migrate(migrations, migrationSession(client), config);
  return migrations;
}

async function currentDatabase(client: PgClient): Promise<string> {
  const rows = await client`SELECT current_database() AS name`;
  return String(rows[0]?.name ?? "");
}

async function assertLedgerMatches(
  client: PgClient,
  migrations: MigrationMeta[],
): Promise<void> {
  const rows = await client<LedgerRow[]>`
    SELECT hash, created_at::text AS created_at
    FROM drizzle.__drizzle_migrations
    -- journal 的历史 folderMillis 并非严格递增；PgDialect 按 journal 顺序
    -- 追加自增 id，因此 ledger 的应用顺序必须以 id 为准。
    ORDER BY id ASC
  `;
  assertEquals(
    rows.length,
    migrations.length,
    "迁移 ledger 条目数必须与正式迁移集一致",
  );
  for (const [index, migration] of migrations.entries()) {
    assertEquals(
      rows[index]?.hash,
      migration.hash,
      `ledger 第 ${index + 1} 条 hash 不匹配`,
    );
    assertEquals(
      rows[index]?.created_at,
      String(migration.folderMillis),
      `ledger 第 ${index + 1} 条 created_at 不匹配`,
    );
  }
}

async function createDatabase(
  admin: PgClient,
  databaseName: string,
  created: string[],
): Promise<void> {
  assertDatabaseIdentifier(databaseName);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created.push(databaseName);
}

async function dropOwnedDatabases(
  admin: PgClient,
  created: string[],
  prefix: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const databaseName of [...created].reverse()) {
    if (!isOwnedDatabaseName(databaseName, prefix)) continue;
    try {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "迁移升级测试临时数据库清理失败");
  }
}

async function copyMissingMigrationAssets(): Promise<{
  folder: string;
  missingFile: string;
}> {
  const folder = await Deno.makeTempDir({ prefix: "noj-missing-migrations-" });
  await Deno.mkdir(`${folder}/meta`, { recursive: true });
  await Deno.copyFile(
    `${MIGRATIONS_DIR}/meta/_journal.json`,
    `${folder}/meta/_journal.json`,
  );
  const journal = JSON.parse(
    await Deno.readTextFile(`${MIGRATIONS_DIR}/meta/_journal.json`),
  ) as { entries: Array<{ tag: string }> };
  const missingFile = `${journal.entries.at(-1)!.tag}.sql`;
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    if (entry.name === missingFile) continue;
    await Deno.copyFile(
      `${MIGRATIONS_DIR}/${entry.name}`,
      `${folder}/${entry.name}`,
    );
  }
  return { folder, missingFile };
}

async function insertHistoricalRows(client: PgClient): Promise<void> {
  const createdAt = "2024-01-02T03:04:05.000Z";
  await client`
    INSERT INTO users
      (id, username, email, password_hash, email_verified, session_version,
       bio, must_change_password, tfa_enabled, created_at, updated_at)
    VALUES
      (${ROOT_ID}, 'migration_upgrade_root', 'migration_upgrade_root@example.test',
       'not-a-login-secret', true, 0, '', false, false, ${createdAt}, ${createdAt}),
      (${LEGACY_USER_ID}, 'migration_upgrade_legacy', 'migration_upgrade_legacy@example.test',
       'not-a-login-secret', true, 0, '历史用户', false, false, ${createdAt}, ${createdAt})
  `;
  await client`
    INSERT INTO domains
      (id, slug, name, description, status, owner_id, preset, configuration,
       revision, next_problem_number, created_at, updated_at)
    VALUES
      (${DOMAIN_ID}, 'migration-upgrade-domain', '迁移升级域', '', 'active', ${ROOT_ID},
       'community', ${JSON.stringify({ access: "public" })}::jsonb, 0, 1001,
       ${createdAt}, ${createdAt})
  `;
  await client`
    INSERT INTO domain_invitations
      (id, domain_id, classroom_id, token_hash, email, expires_at, used_at,
       revoked_at, created_by, created_at)
    VALUES
      (${PENDING_INVITATION_ID}, ${DOMAIN_ID}, NULL, 'migration-pending-token',
       'pending@example.test', ${EXPIRES_AT}, NULL, NULL, ${ROOT_ID}, ${createdAt}),
      (${USED_INVITATION_ID}, ${DOMAIN_ID}, NULL, 'migration-used-token',
       'used@example.test', ${EXPIRES_AT}, ${REDEEMED_AT}, NULL, ${ROOT_ID}, ${createdAt})
  `;
}

async function assertCurrentSchemaAndUsers(
  client: PgClient,
  expectedDatabase: string,
): Promise<void> {
  assertEquals(await currentDatabase(client), expectedDatabase);
  const rows = await client`
    SELECT to_regclass('public.users')::text AS users_table,
           to_regclass('drizzle.__drizzle_migrations')::text AS ledger_table
  `;
  assertEquals(rows[0]?.users_table, "users");
  assertEquals(rows[0]?.ledger_table, "drizzle.__drizzle_migrations");
}

async function assertInvitationConstraints(client: PgClient): Promise<void> {
  const invalidMode = await assertRejects(() =>
    client`
    INSERT INTO domain_invitations
      (id, domain_id, token_hash, email, expires_at, created_by, created_at,
       mode, max_uses, used_count)
    VALUES
      ('00000000-0000-4000-8000-000000000906', ${DOMAIN_ID},
       'migration-invalid-mode', NULL, ${EXPIRES_AT}, ${ROOT_ID}, ${REDEEMED_AT},
       'invalid', 1, 0)
  `
  );
  assert(String(invalidMode).includes("domain_invitations_mode_check"));

  const invalidTarget = await assertRejects(() =>
    client`
    INSERT INTO domain_invitations
      (id, domain_id, token_hash, email, expires_at, created_by, created_at,
       mode, max_uses, used_count)
    VALUES
      ('00000000-0000-4000-8000-000000000907', ${DOMAIN_ID},
       'migration-invalid-target', 'must-be-null@example.test', ${EXPIRES_AT},
       ${ROOT_ID}, ${REDEEMED_AT}, 'once', 1, 0)
  `
  );
  assert(String(invalidTarget).includes("domain_invitations_target_check"));

  const invalidUses = await assertRejects(() =>
    client`
    INSERT INTO domain_invitations
      (id, domain_id, token_hash, email, expires_at, created_by, created_at,
       mode, max_uses, used_count)
    VALUES
      ('00000000-0000-4000-8000-000000000908', ${DOMAIN_ID},
       'migration-invalid-uses', NULL, ${EXPIRES_AT}, ${ROOT_ID}, ${REDEEMED_AT},
       'general', 0, 0)
  `
  );
  assert(String(invalidUses).includes("domain_invitations_uses_check"));

  await client`
    INSERT INTO domain_invitations
      (id, domain_id, token_hash, email, expires_at, created_by, created_at,
       code_hash, mode, max_uses, used_count)
    VALUES
      (${GENERAL_INVITATION_ID}, ${DOMAIN_ID}, 'migration-general-token', NULL,
       ${EXPIRES_AT}, ${ROOT_ID}, ${REDEEMED_AT}, 'migration-code-hash',
       'general', NULL, 0)
  `;
  const duplicateCode = await assertRejects(() =>
    client`
    INSERT INTO domain_invitations
      (id, domain_id, token_hash, email, expires_at, created_by, created_at,
       code_hash, mode, max_uses, used_count)
    VALUES
      ('00000000-0000-4000-8000-000000000909', ${DOMAIN_ID},
       'migration-duplicate-code-token', NULL, ${EXPIRES_AT}, ${ROOT_ID},
       ${REDEEMED_AT}, 'migration-code-hash', 'general', NULL, 0)
  `
  );
  assert(String(duplicateCode).includes("domain_invitations_code_hash_unique"));

  await client`
    INSERT INTO domain_invitation_redemptions
      (invitation_id, user_id, redeemed_at)
    VALUES (${USED_INVITATION_ID}, ${LEGACY_USER_ID}, ${REDEEMED_AT})
  `;
  const duplicateRedemption = await assertRejects(() =>
    client`
    INSERT INTO domain_invitation_redemptions
      (invitation_id, user_id, redeemed_at)
    VALUES (${USED_INVITATION_ID}, ${LEGACY_USER_ID}, ${REDEEMED_AT})
  `
  );
  assert(
    String(duplicateRedemption).includes(
      "domain_invitation_redemptions_invitation_id_user_id_pk",
    ),
  );
}

Deno.test({
  name: "launcher upgrade: 真实空库全链迁移、存量 0118 到 0119 回填和资产负例",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 先验证正式 child 本身，防止这个集成测试绕过启动器直接使用未知数据库。
    const currentRunDatabase = await assertOwnedTestDatabase();
    assert(currentRunDatabase.startsWith("noj_test_"));

    const admin = openClient(adminUrlForCurrentDatabase());
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const prefix = assertDatabaseIdentifier(`noj_test_upgrade_${suffix}`);
    const emptyDatabase = assertDatabaseIdentifier(`${prefix}_empty`);
    const legacyDatabase = assertDatabaseIdentifier(`${prefix}_legacy`);
    const missingAssetsDatabase = assertDatabaseIdentifier(`${prefix}_missing`);
    const createdDatabases: string[] = [];
    let missingAssetsFolder: string | undefined;
    try {
      const migrations = readMigrationFiles(MIGRATION_CONFIG);
      assert(migrations.length > 1, "正式迁移集必须至少包含 0118 和 0119");
      const journal = JSON.parse(
        await Deno.readTextFile(`${MIGRATIONS_DIR}/meta/_journal.json`),
      ) as { entries: Array<{ tag: string }> };
      assertEquals(journal.entries.at(-2)?.tag, "0118_polite_fat_cobra");
      assertEquals(journal.entries.at(-1)?.tag, "0119_nasty_thena");

      // 空库：完整正式迁移必须真实执行成功，并产生完整 ledger。
      await createDatabase(admin, emptyDatabase, createdDatabases);
      const emptyClient = openClient(
        databaseUrlFor(adminUrlForCurrentDatabase(), emptyDatabase),
      );
      try {
        const migrated = await migrateWithAssets(emptyClient, MIGRATIONS_DIR);
        assertEquals(migrated.length, migrations.length);
        await assertCurrentSchemaAndUsers(emptyClient, emptyDatabase);
        await assertLedgerMatches(emptyClient, migrations);
      } finally {
        await emptyClient.end({ timeout: 5 });
      }

      // 存量库：只迁移到 0118，插入历史数据，再由正式 0119 做升级。
      await createDatabase(admin, legacyDatabase, createdDatabases);
      const legacyClient = openClient(
        databaseUrlFor(adminUrlForCurrentDatabase(), legacyDatabase),
      );
      try {
        const beforeUpgrade = migrations.slice(0, -1);
        await new PgDialect().migrate(
          beforeUpgrade,
          migrationSession(legacyClient),
          MIGRATION_CONFIG,
        );
        await assertCurrentSchemaAndUsers(legacyClient, legacyDatabase);
        await assertLedgerMatches(legacyClient, beforeUpgrade);
        await insertHistoricalRows(legacyClient);

        await new PgDialect().migrate(
          migrations,
          migrationSession(legacyClient),
          MIGRATION_CONFIG,
        );
        await assertCurrentSchemaAndUsers(legacyClient, legacyDatabase);
        await assertLedgerMatches(legacyClient, migrations);

        const users = await legacyClient`
          SELECT id, username, email FROM users
          WHERE id IN (${ROOT_ID}, ${LEGACY_USER_ID}) ORDER BY id
        `;
        assertEquals(users.length, 2, "历史用户必须保留");
        const invitations = await legacyClient`
          SELECT id, email, used_at, used_count, mode, max_uses
          FROM domain_invitations
          WHERE id IN (${PENDING_INVITATION_ID}, ${USED_INVITATION_ID})
          ORDER BY id
        `;
        assertEquals(invitations.length, 2, "历史邀请必须保留");
        assertEquals(invitations[0]?.email, "pending@example.test");
        assertEquals(invitations[0]?.used_at, null);
        assertEquals(invitations[0]?.used_count, 0);
        assertEquals(invitations[0]?.mode, "email");
        assertEquals(invitations[0]?.max_uses, 1);
        assertEquals(invitations[1]?.email, "used@example.test");
        assertEquals(invitations[1]?.used_at, REDEEMED_AT);
        assertEquals(
          invitations[1]?.used_count,
          1,
          "used_at 必须回填 used_count=1",
        );
        assertEquals(invitations[1]?.mode, "email");
        assertEquals(invitations[1]?.max_uses, 1);

        await assertInvitationConstraints(legacyClient);
        const redemption = await legacyClient`
          SELECT invitation_id, user_id, redeemed_at
          FROM domain_invitation_redemptions
          WHERE invitation_id = ${USED_INVITATION_ID}
            AND user_id = ${LEGACY_USER_ID}
        `;
        assertEquals(redemption.length, 1, "邀请兑换记录必须可写入并保留");
        assertEquals(redemption[0]?.redeemed_at, REDEEMED_AT);
      } finally {
        await legacyClient.end({ timeout: 5 });
      }

      // 缺失迁移资产：官方读取入口必须在真实空库上失败，且不能留下半套 schema。
      await createDatabase(admin, missingAssetsDatabase, createdDatabases);
      const missingClient = openClient(
        databaseUrlFor(adminUrlForCurrentDatabase(), missingAssetsDatabase),
      );
      try {
        const assets = await copyMissingMigrationAssets();
        missingAssetsFolder = assets.folder;
        const error = await assertRejects(() =>
          migrateWithAssets(missingClient, assets.folder)
        );
        assert(String(error).includes("No file"));
        assert(String(error).includes(assets.missingFile));
        const state = await missingClient`
          SELECT to_regclass('public.users')::text AS users_table,
                 to_regclass('drizzle.__drizzle_migrations')::text AS ledger_table
        `;
        assertEquals(state[0]?.users_table, null);
        assertEquals(state[0]?.ledger_table, null);
      } finally {
        await missingClient.end({ timeout: 5 });
      }
    } finally {
      if (missingAssetsFolder) {
        await Deno.remove(missingAssetsFolder, { recursive: true });
      }
      try {
        await dropOwnedDatabases(admin, createdDatabases, prefix);
      } finally {
        await admin.end({ timeout: 5 });
      }
    }
  },
});
