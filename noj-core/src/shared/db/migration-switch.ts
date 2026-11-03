/**
 * 授权模型切换的旧库门禁。
 *
 * 本版本只支持全新初始化：既有业务库必须被明确拒绝，而不是通过列默认值
 * 把旧管理员悄悄降级为普通用户。检查在迁移锁内、调用 Drizzle migrator
 * 之前执行，因此失败时不会施加任何 DDL。
 *
 * 判定口径：
 * - 没有迁移 ledger 且没有 NOJ 业务表 → 允许（空库全新建库）。
 * - ledger 已包含切换迁移 → 允许（重复执行或后续正常迁移）。
 * - ledger 停留在切换迁移之前 → 拒绝（旧授权模型无法无损转换）。
 * - 有 NOJ 表但缺 ledger、未知迁移或历史漂移 → 拒绝。
 * - 查询失败 → 拒绝，不把无法判断当成空库。
 */
import { sql } from "drizzle-orm";
import { getDb } from "./connection.ts";
import { resolveMigrationsDirectory } from "./migrate.ts";
import { resolve } from "jsr:@std/path@^1";

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

interface JournalEntry {
  tag?: unknown;
}

interface JournalDocument {
  entries?: JournalEntry[];
}

/** 读取打包 journal，返回切换迁移的 0 基下标；找不到即配置错误。 */
export async function resolveSwitchMigrationIndex(
  migrationsDir = resolveMigrationsDirectory(),
): Promise<number> {
  const path = resolve(migrationsDir, "meta", "_journal.json");
  let document: JournalDocument;
  try {
    document = JSON.parse(await Deno.readTextFile(path)) as JournalDocument;
  } catch (error) {
    throw new LegacyDatabaseError(
      `读取迁移 journal 失败（${path}），无法判断数据库兼容性；迁移已终止`,
      { cause: error },
    );
  }
  const entries = document.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new LegacyDatabaseError(`迁移 journal 无有效 entries（${path}）`);
  }
  const index = entries.findIndex((entry) =>
    entry?.tag === AUTHORIZATION_SWITCH_MIGRATION_TAG
  );
  if (index < 0) {
    throw new LegacyDatabaseError(
      `迁移 journal 未包含授权切换迁移 ${AUTHORIZATION_SWITCH_MIGRATION_TAG}`,
    );
  }
  return index;
}

interface ScalarRow {
  value?: unknown;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await getDb().execute(query) as unknown as ScalarRow[];
  return Number(rows[0]?.value ?? 0);
}

/** 在迁移锁内执行只读门禁；任何判断失败都抛错而不是放行。 */
export async function assertDatabaseSupportsAuthorizationSwitch(): Promise<
  void
> {
  const switchIndex = await resolveSwitchMigrationIndex();

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
        AND table_name IN (
          'users', 'domains', 'problems', 'submissions',
          'system_settings', 'domain_memberships', 'user_roles'
        )
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

  let applied: number;
  try {
    applied = await scalar(sql`
      SELECT count(*)::int AS value FROM drizzle.__drizzle_migrations
    `);
  } catch (error) {
    throw new LegacyDatabaseError(
      "读取迁移 ledger 失败，拒绝继续迁移（不把无法判断当成空库）",
      { cause: error },
    );
  }

  if (applied === 0) {
    // 有 ledger 表但没有记录：等同旧库漂移，除非确实没有任何业务表。
    if (nojTableCount === 0) return;
    throw new LegacyDatabaseError(
      "迁移 ledger 为空但存在 NOJ 业务表：历史漂移，此版本仅支持全新初始化",
    );
  }
  if (applied > switchIndex) return;
  throw new LegacyDatabaseError(
    "检测到旧授权模型数据库（ledger 停留在授权切换迁移之前）：" +
      "此版本仅支持全新初始化，不提供旧角色/成员授权的数据转换。" +
      "请导出备份后使用新数据库重新安装，或回退到上一版本",
  );
}
