/**
 * `v0.10.6 → v0.11` 源库与目标库前置校验。
 *
 * 严格遵循零副作用与凭据脱敏原则：所有报错不得回显数据库 URL 或密码。
 */

import { resolveMigrationsDirectory } from "../../src/shared/db/migrations-path.ts";
import {
  type ActualMigration,
  readExpectedMigrations,
  validateMigrationLedger,
} from "../../src/shared/db/schema-compat.ts";
import {
  assertPgIdentifier,
  countTableRows,
  listPublicTables,
  type PgExecutor,
} from "./copy-helpers.ts";
import { V010_LAST_MIGRATION_TAG } from "./transform.ts";
import { UpgradeV010Error } from "./types.ts";

interface DbIdentity {
  database: string;
  systemIdentifier: string | null;
  serverAddr: string | null;
  serverPort: number | null;
}

interface UnsafeQueryable {
  unsafe: PgExecutor["unsafe"];
}

async function readDbIdentity(sql: UnsafeQueryable): Promise<DbIdentity> {
  const rows = await sql.unsafe<{
    database: string;
    server_addr: string | null;
    server_port: number | null;
  }[]>(`
    SELECT
      current_database() AS database,
      inet_server_addr()::text AS server_addr,
      inet_server_port()::int AS server_port
  `);
  const base = rows[0];
  let systemIdentifier: string | null = null;
  try {
    const sysRows = await sql.unsafe<{ system_identifier: string }[]>(`
      SELECT system_identifier::text AS system_identifier
      FROM pg_control_system()
    `);
    systemIdentifier = sysRows[0]?.system_identifier ?? null;
  } catch {
    // 非超级用户可能无权调用 pg_control_system()，回退到 addr/port/db 校验
  }
  return {
    database: String(base?.database ?? ""),
    systemIdentifier,
    serverAddr: base?.server_addr ?? null,
    serverPort: base?.server_port ?? null,
  };
}

/** 校验源库与目标库不是同一个 PostgreSQL 实例上的同一个数据库。 */
export async function assertDistinctDatabases(
  sourceSql: UnsafeQueryable,
  targetSql: UnsafeQueryable,
): Promise<void> {
  const [src, dst] = await Promise.all([
    readDbIdentity(sourceSql),
    readDbIdentity(targetSql),
  ]);
  const sameBySystemId = src.systemIdentifier !== null &&
    dst.systemIdentifier !== null &&
    src.systemIdentifier === dst.systemIdentifier &&
    src.database === dst.database;
  const sameByEndpoint = src.serverPort !== null &&
    dst.serverPort !== null &&
    src.serverPort === dst.serverPort &&
    (src.serverAddr ?? "") === (dst.serverAddr ?? "") &&
    src.database === dst.database;

  if (sameBySystemId || sameByEndpoint) {
    throw new UpgradeV010Error(
      "SAME_DATABASE",
      "源库与目标库指向同一个 PostgreSQL 数据库；升级必须写入全新的空 v0.11 目标库",
      { database: src.database },
    );
  }
}

async function readLedgerRows(
  sql: PgExecutor,
): Promise<ActualMigration[] | null> {
  const tableCheck = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
  `;
  if (!tableCheck[0]?.exists) {
    return null;
  }
  const rows = await sql<ActualMigration[]>`
    SELECT
      migration_ledger.id::text AS id,
      migration_ledger.hash,
      migration_ledger.created_at::text AS "createdAt"
    FROM drizzle.__drizzle_migrations AS migration_ledger
    ORDER BY migration_ledger.id ASC
  `;
  return rows.map((r) => ({
    id: String(r.id),
    hash: String(r.hash),
    createdAt: String(r.createdAt),
  }));
}

export interface ValidatedMigrationPlan {
  v010Count: number;
  v011Count: number;
}

const REQUIRED_SOURCE_TABLES = [
  "users",
  "problems",
  "problem_versions",
  "roles",
  "permissions",
  "role_permissions",
  "user_roles",
  "community_notifications",
  "submissions",
  "objective_submissions",
] as const;

/** 目标库空库检查时允许存在的非空表（仅迁移账本/投影初始哨兵）。 */
const ALLOWED_NONEMPTY_TARGET_TABLES = new Set([
  "llm_schema_migrations",
  "query_projection_revisions",
]);

/** 校验源库是否为完整且受支持的 `v0.10.6`（`0000..0115`）。 */
export async function validateSourceDatabase(
  sourceTx: PgExecutor,
  migrationsDir = resolveMigrationsDirectory(),
): Promise<number> {
  const expectedAll = await readExpectedMigrations(migrationsDir);
  const v010EndIdx = expectedAll.findIndex(
    (entry) => entry.tag === V010_LAST_MIGRATION_TAG,
  );
  if (v010EndIdx === -1) {
    throw new UpgradeV010Error(
      "SOURCE_INVALID_SCHEMA",
      `发布集迁移目录缺少 v0.10.6 基线标记 ${V010_LAST_MIGRATION_TAG}`,
    );
  }
  const v010Expected = expectedAll.slice(0, v010EndIdx + 1);
  const actual = await readLedgerRows(sourceTx);
  if (!actual) {
    throw new UpgradeV010Error(
      "SOURCE_INVALID_SCHEMA",
      "源库缺少 drizzle.__drizzle_migrations 迁移记录表，无法识别版本",
    );
  }
  const mismatch = validateMigrationLedger(v010Expected, actual, "startup");
  if (mismatch) {
    throw new UpgradeV010Error(
      "SOURCE_UNSUPPORTED_VERSION",
      `源库必须是完整的 v0.10.6（0000..${V010_LAST_MIGRATION_TAG}，共 ${v010Expected.length} 条迁移）：${mismatch}`,
      { expectedCount: v010Expected.length, actualCount: actual.length },
    );
  }

  const publicTables = new Set(await listPublicTables(sourceTx));
  const missingTables = REQUIRED_SOURCE_TABLES.filter(
    (t) => !publicTables.has(t),
  );
  if (missingTables.length > 0) {
    throw new UpgradeV010Error(
      "SOURCE_INVALID_SCHEMA",
      `源库缺少必需表: ${missingTables.join(", ")}`,
      { missingTables },
    );
  }

  return v010Expected.length;
}

/** 校验目标库是否已完成 `v0.11` 全量迁移且除迁移种子外完全为空。 */
export async function validateTargetDatabase(
  targetTx: PgExecutor,
  migrationsDir = resolveMigrationsDirectory(),
): Promise<{ v011Count: number; publicTables: Set<string> }> {
  const expectedAll = await readExpectedMigrations(migrationsDir);
  const actual = await readLedgerRows(targetTx);
  if (!actual) {
    throw new UpgradeV010Error(
      "TARGET_INVALID_SCHEMA",
      "目标库缺少 drizzle.__drizzle_migrations；请先对空目标库运行 v0.11 迁移",
    );
  }
  const mismatch = validateMigrationLedger(expectedAll, actual, "startup");
  if (mismatch) {
    throw new UpgradeV010Error(
      "TARGET_INVALID_SCHEMA",
      `目标库迁移账本与当前 v0.11 发布集不匹配：${mismatch}`,
      { expectedCount: expectedAll.length, actualCount: actual.length },
    );
  }

  const tableNames = await listPublicTables(targetTx);
  const nonEmptyTables: string[] = [];

  for (const tableName of tableNames) {
    if (ALLOWED_NONEMPTY_TARGET_TABLES.has(tableName)) {
      continue;
    }
    const count = await countTableRows(targetTx, tableName);
    if (count > 0) {
      nonEmptyTables.push(`${tableName}(${count})`);
    }
  }

  if (tableNames.includes("query_projection_revisions")) {
    const qprRows = await targetTx<{
      scope_key: string;
      materialized_revision: number;
    }[]>`
      SELECT scope_key, materialized_revision
      FROM query_projection_revisions
    `;
    const isInitialSeedOnly = qprRows.length === 0 ||
      (qprRows.length === 1 &&
        qprRows[0]?.scope_key === "global" &&
        Number(qprRows[0]?.materialized_revision) === 0);
    if (!isInitialSeedOnly) {
      nonEmptyTables.push(`query_projection_revisions(${qprRows.length})`);
    }
  }

  if (nonEmptyTables.length > 0) {
    assertPgIdentifier("domains");
    const hints: string[] = [];
    if (nonEmptyTables.some((t) => t.startsWith("llm_quotas("))) {
      hints.push(
        "llm_quotas 通常来自 Gateway 默认配额种子：初始化目标库请改用 `deno task db:migrate --schema-only`（Gateway）",
      );
    }
    if (nonEmptyTables.some((t) => !t.startsWith("llm_quotas("))) {
      hints.push(
        "Core 目标库只执行 `noj db migrate`，不要执行 `noj init system`、`dev-setup` 或管理员引导",
      );
    }
    throw new UpgradeV010Error(
      "TARGET_NOT_EMPTY",
      `目标库必须为空的全新 v0.11 数据库，检测到已有数据的表: ${
        nonEmptyTables.join(", ")
      }${hints.length > 0 ? `。${hints.join("；")}` : ""}`,
      { nonEmptyTables },
    );
  }

  return {
    v011Count: expectedAll.length,
    publicTables: new Set(tableNames),
  };
}
