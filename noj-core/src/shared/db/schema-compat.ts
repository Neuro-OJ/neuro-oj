/**
 * 生产 HTTP 启动期的只读 schema 兼容检查。
 *
 * 迁移由 `noj db migrate` / 安装升级流程显式执行。HTTP 进程只读取打包的
 * journal + SQL 与数据库 ledger，发现缺失、多出、漂移或查询失败时拒绝启动，
 * 并要求运维先执行显式迁移。
 */
import { sql } from "drizzle-orm";
import { getDb } from "./connection.ts";
import { resolve } from "jsr:@std/path@^1";
import { resolveMigrationsDirectory } from "./migrate.ts";

const MIGRATION_LEDGER = "drizzle.__drizzle_migrations";

export interface ExpectedMigration {
  tag: string;
  hash: string;
  createdAt: string;
}

export interface ActualMigration {
  id: string;
  hash: string;
  createdAt: string;
}

export interface SchemaCompatibilityDeps {
  /** 读取数据库迁移 ledger；生产实现只执行 SELECT。 */
  queryLedger: () => Promise<ActualMigration[]>;
  /** 读取文件内容；测试可注入内存文件。 */
  readText: (path: string) => Promise<string>;
  /** 读取迁移目录文件名；测试可注入文件清单。 */
  listFiles: (directory: string) => Promise<string[]>;
}

export class SchemaCompatibilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchemaCompatibilityError";
  }
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

interface JournalDocument {
  entries?: JournalEntry[];
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function migrationDirFromModule(): string {
  return resolveMigrationsDirectory();
}

function defaultDeps(): SchemaCompatibilityDeps {
  return {
    queryLedger: async () => {
      const rows = await getDb().execute(sql`
        SELECT migration_ledger.id::text AS id,
          migration_ledger.hash,
          migration_ledger.created_at::text AS created_at
        FROM ${sql.raw(MIGRATION_LEDGER)} AS migration_ledger
        ORDER BY migration_ledger.id ASC
      `) as unknown as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id ?? ""),
        hash: String(row.hash ?? ""),
        createdAt: String(row.created_at ?? ""),
      }));
    },
    readText: (path) => Deno.readTextFile(path),
    listFiles: async (directory) => {
      const names: string[] = [];
      for await (const entry of Deno.readDir(directory)) {
        if (entry.isFile) names.push(entry.name);
      }
      return names;
    },
  };
}

/** 从打包的 journal + SQL 读取期望 ledger，严格拒绝文件差集。 */
export async function readExpectedMigrations(
  migrationsDir = migrationDirFromModule(),
  deps: Pick<SchemaCompatibilityDeps, "readText" | "listFiles"> = defaultDeps(),
): Promise<ExpectedMigration[]> {
  const journalPath = resolve(migrationsDir, "meta", "_journal.json");
  let journal: JournalDocument;
  try {
    journal = JSON.parse(await deps.readText(journalPath)) as JournalDocument;
  } catch (error) {
    throw new SchemaCompatibilityError(
      `读取打包迁移 journal 失败（${journalPath}）：${
        asErrorMessage(error)
      }。` +
        "HTTP 启动拒绝继续；请执行显式迁移并确认发布集包含完整 drizzle 资产。",
      { cause: error },
    );
  }

  const entries = journal.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new SchemaCompatibilityError(
      `打包迁移 journal 无有效 entries（${journalPath}）。` +
        "HTTP 启动拒绝继续；请检查发布集并执行显式迁移。",
    );
  }

  const seenTags = new Set<string>();
  const expectedFiles = new Set<string>();
  const expected: ExpectedMigration[] = [];
  const seenIndexes = new Set<number>();
  let previousIndex = -1;
  for (const entry of entries) {
    if (
      !entry || typeof entry.tag !== "string" || entry.tag.length === 0 ||
      !Number.isSafeInteger(entry.when) || entry.when < 0
    ) {
      throw new SchemaCompatibilityError(
        `打包迁移 journal 包含非法条目：${JSON.stringify(entry)}。` +
          "HTTP 启动拒绝继续；请重新生成并发布迁移资产。",
      );
    }
    if (
      !Number.isSafeInteger(entry.idx) || entry.idx < 0 ||
      /[^A-Za-z0-9_-]/.test(entry.tag)
    ) {
      throw new SchemaCompatibilityError(
        `打包迁移 journal 包含非法 tag/idx：${JSON.stringify(entry)}。` +
          "HTTP 启动拒绝继续；请重新生成并发布迁移资产。",
      );
    }
    if (seenIndexes.has(entry.idx)) {
      throw new SchemaCompatibilityError(
        `打包迁移 journal 存在重复 idx：${entry.idx}。` +
          "HTTP 启动拒绝继续；请重新生成并发布迁移资产。",
      );
    }
    if (entry.idx <= previousIndex) {
      throw new SchemaCompatibilityError(
        `打包迁移 journal 的 idx 未严格递增：${entry.idx}。` +
          "HTTP 启动拒绝继续；请重新生成并发布迁移资产。",
      );
    }
    seenIndexes.add(entry.idx);
    previousIndex = entry.idx;
    if (seenTags.has(entry.tag)) {
      throw new SchemaCompatibilityError(
        `打包迁移 journal 存在重复 tag：${entry.tag}。` +
          "HTTP 启动拒绝继续；请重新生成并发布迁移资产。",
      );
    }
    seenTags.add(entry.tag);
    const fileName = `${entry.tag}.sql`;
    expectedFiles.add(fileName);
    let content: string;
    try {
      content = await deps.readText(resolve(migrationsDir, fileName));
    } catch (error) {
      throw new SchemaCompatibilityError(
        `打包迁移缺少 SQL 文件：${fileName}。` +
          "HTTP 启动拒绝继续；请先执行显式迁移或修复发布集。",
        { cause: error },
      );
    }
    expected.push({
      tag: entry.tag,
      hash: await sha256Hex(content),
      createdAt: String(entry.when),
    });
  }

  let files: string[];
  try {
    files = await deps.listFiles(migrationsDir);
  } catch (error) {
    throw new SchemaCompatibilityError(
      `读取打包迁移目录失败（${migrationsDir}）：${asErrorMessage(error)}。` +
        "HTTP 启动拒绝继续；请确认发布集包含完整 drizzle 资产。",
      { cause: error },
    );
  }
  const actualSqlFiles = files.filter((file) => file.endsWith(".sql"));
  const extras = actualSqlFiles.filter((file) => !expectedFiles.has(file));
  if (extras.length > 0) {
    throw new SchemaCompatibilityError(
      `打包迁移存在未登记 SQL 文件：${extras.sort().join(", ")}。` +
        "journal 与 SQL 不匹配，HTTP 启动拒绝继续；请显式生成/应用迁移并修复发布集。",
    );
  }
  return expected;
}

function compareMigrationLedgers(
  expected: ExpectedMigration[],
  actual: ActualMigration[],
): string | null {
  if (actual.length < expected.length) {
    return `数据库迁移 ledger 缺少记录（期望 ${expected.length} 条，实际 ${actual.length} 条）`;
  }
  if (actual.length > expected.length) {
    return `数据库迁移 ledger 存在发布集之外的记录（期望 ${expected.length} 条，实际 ${actual.length} 条）`;
  }
  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index]!;
    const found = actual[index]!;
    if (wanted.hash !== found.hash || wanted.createdAt !== found.createdAt) {
      return `数据库迁移 ledger 第 ${index + 1} 条不匹配（${wanted.tag}）：` +
        `期望 hash=${wanted.hash}, created_at=${wanted.createdAt}；` +
        `实际 hash=${found.hash}, created_at=${found.createdAt}`;
    }
  }
  return null;
}

/** 执行只读 schema 检查；成功返回期望/实际 ledger，失败抛显式迁移错误。 */
export async function assertSchemaCompatible(
  options: {
    migrationsDir?: string;
    deps?: Partial<SchemaCompatibilityDeps>;
  } = {},
): Promise<{ expected: ExpectedMigration[]; actual: ActualMigration[] }> {
  const defaults = defaultDeps();
  const deps: SchemaCompatibilityDeps = { ...defaults, ...options.deps };
  const expected = await readExpectedMigrations(options.migrationsDir, deps);
  let actual: ActualMigration[];
  try {
    actual = await deps.queryLedger();
  } catch (error) {
    throw new SchemaCompatibilityError(
      `读取数据库迁移 ledger ${MIGRATION_LEDGER} 失败：${
        asErrorMessage(error)
      }。` +
        "HTTP 启动仅支持已迁移数据库，未执行任何 DDL；请先运行 `noj db migrate`。",
      { cause: error },
    );
  }
  const mismatch = compareMigrationLedgers(expected, actual);
  if (mismatch) {
    throw new SchemaCompatibilityError(
      `${mismatch}。HTTP 启动拒绝继续，未执行任何 DDL 或初始化；请先运行 noj db migrate。`,
    );
  }
  return { expected, actual };
}

/** 仅用于测试的纯 ledger 比较入口。 */
export function compareSchemaLedgers(
  expected: ExpectedMigration[],
  actual: ActualMigration[],
): string | null {
  return compareMigrationLedgers(expected, actual);
}
