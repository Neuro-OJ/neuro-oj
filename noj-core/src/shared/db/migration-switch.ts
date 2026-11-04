/**
 * 授权模型切换的旧库门禁与迁移 ledger 校验。
 *
 * 本版本只支持全新初始化：既有旧授权模型库必须被明确拒绝，而不是通过列
 * 默认值把旧管理员悄悄降级为普通用户。检查在迁移锁内、调用 Drizzle
 * migrator 之前执行，因此失败时不会施加任何 DDL。
 *
 * 两种校验模式共用 `schema-compat.ts` 的 `validateMigrationLedger`：
 * - `startup`（HTTP 启动，`assertSchemaCompatible`）：ledger 必须与打包集完全一致；
 * - `pre-migration`（`db migrate` / `db check-upgrade`）：允许合法已应用前缀，
 *   但必须逐条核对 hash、时间戳与顺序。
 *
 * 判定口径：
 * - 没有 ledger 且没有 NOJ 业务表 → 允许（空库全新建库）。
 * - ledger 是合法前缀且已包含切换迁移 → 允许（重复执行或后续正常迁移）。
 * - ledger 是合法前缀但停留在切换迁移之前 → 拒绝（旧授权模型无法无损转换）。
 * - ledger 存在发布集之外的记录、缺中间记录、同条数漂移、未知历史 → 拒绝。
 * - 查询失败 → 拒绝，不把无法判断当成空库。
 */
import { sql } from "drizzle-orm";
import { getDb } from "./connection.ts";
import { resolveMigrationsDirectory } from "./migrations-path.ts";
import {
  type ExpectedMigration,
  type MigrationValidationMode,
  readExpectedMigrations,
  validateMigrationLedger,
} from "./schema-compat.ts";

/**
 * 引入单值平台/域角色并改写审计动作的迁移 tag。
 *
 * 该 tag 是“授权模型切换”的唯一分界；后续正常迁移不受此门禁影响。
 */
export const AUTHORIZATION_SWITCH_MIGRATION_TAG = "0132_eager_gamma_corps";

/** 旧库门禁失败；调用方必须终止迁移，不得降级为继续执行。 */
export class LegacyDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyDatabaseError";
  }
}

/** ledger 行；id 顺序即 journal 应用顺序。 */
interface MigrationLedgerRow {
  hash: string;
  createdAt: string;
}

/** 业务表清单：用于识别“有结构但没有 ledger”的旧库。 */
const NOJ_BUSINESS_TABLES = [
  "users",
  "domains",
  "problems",
  "submissions",
  "system_settings",
  "domain_memberships",
  "domain_creation_requests",
  "audit_logs",
] as const;

interface ScalarRow {
  value?: unknown;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await getDb().execute(query) as unknown as ScalarRow[];
  return Number(rows[0]?.value ?? 0);
}

/** 读取 ledger；表不存在时返回空数组。 */
async function readLedger(): Promise<MigrationLedgerRow[]> {
  const rows = await getDb().execute(sql`
    SELECT migration_ledger.hash,
      migration_ledger.created_at::text AS created_at
    FROM drizzle.__drizzle_migrations AS migration_ledger
    ORDER BY migration_ledger.id ASC
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    hash: String(row.hash ?? ""),
    createdAt: String(row.created_at ?? ""),
  }));
}

/** 在迁移锁内执行只读门禁；任何判断失败都抛错而不是放行。 */
export async function assertDatabaseSupportsAuthorizationSwitch(
  options: {
    mode?: MigrationValidationMode;
    migrationsDir?: string;
  } = {},
): Promise<void> {
  const mode = options.mode ?? "pre-migration";
  let expected: ExpectedMigration[];
  try {
    expected = await readExpectedMigrations(
      options.migrationsDir ?? resolveMigrationsDirectory(),
    );
  } catch (error) {
    throw new LegacyDatabaseError(
      `读取打包迁移 journal/SQL 失败：${
        error instanceof Error ? error.message : String(error)
      }；迁移已终止`,
      { cause: error },
    );
  }
  const switchIndex = expected.findIndex((entry) =>
    entry.tag === AUTHORIZATION_SWITCH_MIGRATION_TAG
  );
  if (switchIndex < 0) {
    throw new LegacyDatabaseError(
      `迁移 journal 未包含授权切换迁移 ${AUTHORIZATION_SWITCH_MIGRATION_TAG}`,
    );
  }

  let ledgerExists: boolean;
  let nojTableCount: number;
  try {
    ledgerExists = (await scalar(sql`
      SELECT (to_regclass('drizzle.__drizzle_migrations') IS NOT NULL)::int AS value
    `)) === 1;
    nojTableCount = await scalar(sql`
      SELECT count(*)::int AS value
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${
      sql.join(NOJ_BUSINESS_TABLES.map((name) => sql`${name}`), sql`, `)
    })
    `);
  } catch (error) {
    throw new LegacyDatabaseError(
      "无法读取数据库迁移状态，拒绝继续迁移；请确认数据库连接与权限后重试",
      { cause: error },
    );
  }

  if (!ledgerExists) {
    if (nojTableCount === 0) return;
    throw new LegacyDatabaseError(
      "检测到既有 NOJ 业务表但缺少迁移 ledger：此版本仅支持全新初始化，" +
        "请使用新数据库与上一版本备份回退，不要在本库上执行本次迁移",
    );
  }

  let actual: MigrationLedgerRow[];
  try {
    actual = await readLedger();
  } catch (error) {
    throw new LegacyDatabaseError(
      "读取迁移 ledger 失败，拒绝继续迁移（不把无法判断当成空库）",
      { cause: error },
    );
  }

  if (actual.length === 0) {
    // 有 ledger 表但没有记录：等同旧库漂移，除非确实没有任何业务表。
    if (nojTableCount === 0) return;
    throw new LegacyDatabaseError(
      "迁移 ledger 为空但存在 NOJ 业务表：历史漂移，此版本仅支持全新初始化",
    );
  }

  const mismatch = validateMigrationLedger(expected, actual, mode);
  if (mismatch) {
    throw new LegacyDatabaseError(
      `${mismatch}。迁移已终止，未执行任何 DDL；此版本仅支持全新初始化，` +
        "请核对发布集与数据库迁移历史后重试",
    );
  }

  if (actual.length <= switchIndex) {
    throw new LegacyDatabaseError(
      "检测到旧授权模型数据库（ledger 停留在授权切换迁移之前）：" +
        "此版本仅支持全新初始化，不提供旧角色/成员授权的数据转换。" +
        "请导出备份后使用新数据库重新安装，或回退到上一版本",
    );
  }
}
