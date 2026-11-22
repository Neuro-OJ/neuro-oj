import postgres from "postgres";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { logger } from "../logger.ts";

/** Gateway 迁移文件计划。 */
export interface GatewayMigrationPlanEntry {
  name: string;
  content: string;
  hash: string;
  createdAt: string;
}

export interface GatewayMigrationLedgerRow {
  id: string;
  name: string;
  hash: string | null;
  createdAt: string | null;
}

export class GatewaySchemaCompatibilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewaySchemaCompatibilityError";
  }
}

/**
 * journal 尚未覆盖的历史文件；新增文件必须先进入 journal。
 *
 * 这里不是按文件名放行的宽松 allowlist：历史文件的 hash 与 ledger 时间戳
 * 也是发布集的一部分。这样即使有人把同名文件换成另一份 SQL，迁移计划也会
 * 在读盘阶段失败，而不是把漂移的 SQL 当成新的基线应用。
 */
const LEGACY_MIGRATIONS = [
  {
    name: "0000_baseline.sql",
    hash: "41b0943f54afc5556e0aded1f9734e2f4fed379a92236b7023abfec051659a4b",
    createdAt: "1000000000000",
  },
  {
    name: "0001_llm_usage_billed_tokens.sql",
    hash: "139199beea422b4c88082a9c38e9a67966fd4fe3dff7ef5ef9629ac5aa8fedb7",
    createdAt: "1000000000001",
  },
  {
    name: "0002_remove_byok_created_by.sql",
    hash: "7c61a3a694f7d5557256d560c565701fbac6168bd1d20a2839919585db150e54",
    createdAt: "1000000000002",
  },
  {
    name: "0003_remove_provider_model.sql",
    hash: "ef6b63edd4b6c943c72998ca4ee62adac6a5da5c4b0c8d19ef8577368e908534",
    createdAt: "1000000000003",
  },
  {
    name: "0004_llm_usage_attempt_scope.sql",
    hash: "fd78f27d24a0005cf7bc2afdaea74c51cf5689fadeb99b52f3d0dc09ce0a2089",
    createdAt: "1000000000004",
  },
  {
    name: "0005_domain_ownership.sql",
    hash: "08311b8ec6c38bc7fa17fc4832de0bc3f964fc730cdafaa6c9c77fcd8216dc03",
    createdAt: "1000000000005",
  },
  {
    name: "0005_provider_rate_limits.sql",
    hash: "ec69e3f9114605babb7c8a81ced27e6ab6365ec9b5314bd4e03c5820dd9c886c",
    createdAt: "1000000000006",
  },
] as const;
const LEGACY_MIGRATION_BY_NAME = new Map<
  string,
  (typeof LEGACY_MIGRATIONS)[number]
>(
  LEGACY_MIGRATIONS.map((migration) => [migration.name, migration]),
);
const LOCK_KEY_1 = 184789;
const LOCK_KEY_2 = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;

function migrationDirectory(): string {
  return Deno.env.get("NOJ_GATEWAY_MIGRATIONS_DIR") ??
    resolve(dirname(fromFileUrl(import.meta.url)), "../../drizzle");
}

export function resolveGatewayMigrationsDirectory(): string {
  return migrationDirectory();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface JournalDocument {
  entries?: unknown[];
}

/** 读取并校验 Gateway 的 journal + SQL 清单；不会访问数据库。 */
export async function readGatewayMigrationPlan(
  dir = migrationDirectory(),
): Promise<GatewayMigrationPlanEntry[]> {
  const journalPath = resolve(dir, "meta", "_journal.json");
  let journal: JournalDocument;
  try {
    journal = JSON.parse(
      await Deno.readTextFile(journalPath),
    ) as JournalDocument;
  } catch (error) {
    throw new GatewaySchemaCompatibilityError(
      `读取 Gateway 迁移 journal 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const entries = journal.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GatewaySchemaCompatibilityError(
      "Gateway 迁移 journal 为空；请修复发布集后执行显式迁移",
    );
  }
  const journalByName = new Map<string, JournalEntry>();
  const seenIndexes = new Set<number>();
  let previousIndex = -1;
  for (const rawEntry of entries) {
    const entry = rawEntry !== null && typeof rawEntry === "object"
      ? rawEntry as Partial<JournalEntry>
      : null;
    const idx = entry?.idx;
    const when = entry?.when;
    const tag = entry?.tag;
    const name = typeof tag === "string" ? `${tag}.sql` : "<invalid>";
    if (
      entry === null || typeof idx !== "number" || !Number.isSafeInteger(idx) ||
      idx < 0 || seenIndexes.has(idx) || idx <= previousIndex ||
      typeof when !== "number" || !Number.isSafeInteger(when) || when < 0 ||
      typeof tag !== "string" || !/^[A-Za-z0-9_-]+$/.test(tag) ||
      journalByName.has(name)
    ) {
      throw new GatewaySchemaCompatibilityError(
        `Gateway 迁移 journal 条目非法、乱序或重复：${
          JSON.stringify(rawEntry)
        }`,
      );
    }
    seenIndexes.add(idx);
    previousIndex = idx;
    journalByName.set(name, { idx, when, tag });
  }

  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
    }
  } catch (error) {
    throw new GatewaySchemaCompatibilityError(
      `读取 Gateway 迁移目录失败：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  files.sort();
  const missingLegacy = LEGACY_MIGRATIONS.filter((migration) =>
    !files.includes(migration.name)
  ).map((migration) => migration.name);
  if (missingLegacy.length > 0) {
    throw new GatewaySchemaCompatibilityError(
      `Gateway 迁移目录缺少历史 SQL：${missingLegacy.join(", ")}；` +
        "历史发布集必须完整",
    );
  }
  const unknownExtras = files.filter((file) =>
    !journalByName.has(file) && !LEGACY_MIGRATION_BY_NAME.has(file)
  );
  if (unknownExtras.length > 0) {
    throw new GatewaySchemaCompatibilityError(
      `Gateway 迁移目录存在未登记 SQL：${unknownExtras.join(", ")}；` +
        "请先生成/登记迁移，再执行显式迁移",
    );
  }
  for (const name of journalByName.keys()) {
    if (!files.includes(name)) {
      throw new GatewaySchemaCompatibilityError(
        `Gateway 迁移目录缺少 journal SQL：${name}`,
      );
    }
  }

  const legacyNames = LEGACY_MIGRATIONS.map((migration) => migration.name);
  const journalNames = [...journalByName.entries()]
    .sort(([, left], [, right]) => left.idx - right.idx)
    .map(([name]) => name);
  const legacyJournalCollisions = legacyNames.filter((name) =>
    journalByName.has(name)
  );
  if (legacyJournalCollisions.length > 0) {
    throw new GatewaySchemaCompatibilityError(
      `Gateway 迁移文件同时属于历史 allowlist 与当前 journal：${
        legacyJournalCollisions.join(", ")
      }；请保留历史文件名并为新迁移使用新 tag`,
    );
  }
  const plan: GatewayMigrationPlanEntry[] = [];
  // 历史 manifest 是稳定前缀；当前 journal 则严格按 idx 排序。
  // 不能按文件名字典序重排 journal，否则 tag 名称变化会改变 ledger 顺序。
  for (const name of [...legacyNames, ...journalNames]) {
    const content = await Deno.readTextFile(resolve(dir, name));
    const journalEntry = journalByName.get(name);
    const legacyEntry = LEGACY_MIGRATION_BY_NAME.get(name);
    const hash = await sha256Hex(content);
    if (legacyEntry && hash !== legacyEntry.hash) {
      throw new GatewaySchemaCompatibilityError(
        `Gateway 历史迁移 hash 漂移：${name}；请恢复固定发布资产后再启动`,
      );
    }
    plan.push({
      name,
      content,
      hash,
      createdAt: journalEntry
        ? String(journalEntry.when)
        : legacyEntry!.createdAt,
    });
  }
  return plan;
}

function compareLedger(
  expected: GatewayMigrationPlanEntry[],
  actual: GatewayMigrationLedgerRow[],
): string | null {
  if (actual.length !== expected.length) {
    return `Gateway 迁移 ledger 数量不匹配（期望 ${expected.length}，实际 ${actual.length}）`;
  }
  for (let i = 0; i < expected.length; i++) {
    const wanted = expected[i]!;
    const found = actual[i]!;
    if (
      found.name !== wanted.name || found.hash !== wanted.hash ||
      found.createdAt !== wanted.createdAt
    ) {
      return `Gateway 迁移 ledger 第 ${
        i + 1
      } 条不匹配（期望 ${wanted.name}/${wanted.hash}/${wanted.createdAt}，` +
        `实际 ${found.name}/${found.hash ?? "null"}/${
          found.createdAt ?? "null"
        }）`;
    }
  }
  return null;
}

/** 纯 ledger 比较入口，供故障/漂移测试使用。 */
export function compareGatewayMigrationLedger(
  expected: GatewayMigrationPlanEntry[],
  actual: GatewayMigrationLedgerRow[],
): string | null {
  return compareLedger(expected, actual);
}

async function readLedger(
  sql: ReturnType<typeof postgres>,
): Promise<GatewayMigrationLedgerRow[]> {
  const rows = await sql<GatewayMigrationLedgerRow[]>`
    SELECT migrations.id::text AS id, migrations.name, migrations.hash,
      migrations.created_at::text AS "createdAt"
    FROM llm_schema_migrations AS migrations
    ORDER BY migrations.id ASC
  `;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    hash: row.hash === null ? null : String(row.hash),
    createdAt: row.createdAt === null ? null : String(row.createdAt),
  }));
}

/** HTTP 启动期只读检查；缺失/多出/漂移均拒绝启动，绝不 DDL。 */
export async function assertMigrationsCompatible(
  databaseUrl: string,
  dir = migrationDirectory(),
): Promise<void> {
  const plan = await readGatewayMigrationPlan(dir);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    let actual: GatewayMigrationLedgerRow[];
    try {
      actual = await readLedger(sql);
    } catch (error) {
      throw new GatewaySchemaCompatibilityError(
        "读取 Gateway 迁移 ledger 失败；HTTP 启动未执行 DDL，请先运行显式 gateway db:migrate",
        { cause: error },
      );
    }
    const mismatch = compareLedger(plan, actual);
    if (mismatch) {
      throw new GatewaySchemaCompatibilityError(
        `${mismatch}；HTTP 启动未执行 DDL，请先运行显式 gateway db:migrate`,
      );
    }
  } finally {
    await sql.end();
  }
}

interface MigrationLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/** 在有界时间内获得会话级迁移锁；超时不执行任何 DDL。 */
async function acquireMigrationLock(
  sql: ReturnType<typeof postgres>,
  { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, pollMs = DEFAULT_LOCK_POLL_MS }:
    MigrationLockOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = await sql<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2}) AS locked
    `;
    if (rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new GatewaySchemaCompatibilityError(
        `Gateway 迁移锁等待超时（${timeoutMs}ms）；未执行 DDL`,
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        Math.min(pollMs, deadline - Date.now()),
      );
      Deno.unrefTimer(timer);
    });
  }
}

/** 执行 Gateway SQL 迁移与 ledger 元数据升级，只由显式 db:migrate 调用。 */
export async function runMigrations(
  databaseUrl: string,
  options: MigrationLockOptions = {},
): Promise<void> {
  const plan = await readGatewayMigrationPlan();
  const sql = postgres(databaseUrl, { max: 1 });
  let lockAcquired = false;
  try {
    await acquireMigrationLock(sql, options);
    lockAcquired = true;
    await sql`
      CREATE TABLE IF NOT EXISTS llm_schema_migrations (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        hash text,
        created_at bigint,
        applied_at text NOT NULL
      )
    `;
    // 旧安装的 ledger 只有 name/applied_at；补列和回填只属于显式迁移步骤。
    await sql`ALTER TABLE llm_schema_migrations ADD COLUMN IF NOT EXISTS hash text`;
    await sql`ALTER TABLE llm_schema_migrations ADD COLUMN IF NOT EXISTS created_at bigint`;

    const existing = await readLedger(sql);
    const known = new Map(existing.map((row) => [row.name, row]));
    for (const row of existing) {
      if (!plan.some((migration) => migration.name === row.name)) {
        throw new GatewaySchemaCompatibilityError(
          `Gateway 迁移 ledger 存在发布集之外的记录：${row.name}`,
        );
      }
    }

    for (const migration of plan) {
      const applied = known.get(migration.name);
      if (applied) {
        if (
          applied.hash !== null && applied.hash !== migration.hash ||
          applied.createdAt !== null &&
            applied.createdAt !== migration.createdAt
        ) {
          throw new GatewaySchemaCompatibilityError(
            `Gateway 迁移记录漂移：${migration.name}；请恢复匹配的发布集或人工核对数据库`,
          );
        }
        if (applied.hash === null || applied.createdAt === null) {
          await sql`UPDATE llm_schema_migrations SET hash=${migration.hash},created_at=${migration.createdAt} WHERE name=${migration.name}`;
        }
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.content);
        await tx`INSERT INTO llm_schema_migrations(name,hash,created_at,applied_at)
          VALUES (${migration.name},${migration.hash},${migration.createdAt},${
          new Date().toISOString()
        })`;
      });
      logger.info("已应用 Gateway 迁移: {file}", { file: migration.name });
    }
  } finally {
    try {
      if (lockAcquired) {
        await sql`SELECT pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`;
      }
    } finally {
      await sql.end();
    }
  }
}
