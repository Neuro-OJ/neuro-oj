/**
 * 隔离 PostgreSQL 测试数据库辅助。
 *
 * 生产连接只使用真实 PostgreSQL；本模块负责测试侧的数据库清空、种子恢复与
 * bootstrap。所有 destructive 操作必须先通过启动器声明的非空、run 唯一前缀和
 * 精确数据库名校验，并在同一连接上核对 `current_database()`，防止误操作系统库
 * 或开发库。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import { runMigrations } from "../../src/shared/db/migrate.ts";
import { judgeImages } from "../../src/shared/db/schema.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";
import { ensureRootUser } from "../../src/domains/identity/index.ts";
import {
  ensureRbacSeeds,
  seedJudgeImages,
} from "../../src/domains/system/index.ts";
import {
  _resetSystemSettingsForTest,
} from "../../src/domains/system/services/system-settings.ts";
import { ensureDefaultWorkspace } from "../../src/domains/workspace/index.ts";

/** 测试数据库必须由启动器声明的环境标记。 */
export const TEST_DATABASE_OWNED_ENV = "NOJ_TEST_DATABASE_OWNED";
/** 测试数据库名前缀；必须由本 run 启动器显式提供且保持唯一。 */
export const TEST_DATABASE_PREFIX_ENV = "NOJ_TEST_DATABASE_PREFIX";
/** 启动器声明的精确数据库名；必须显式提供。 */
export const TEST_DATABASE_NAME_ENV = "NOJ_TEST_DATABASE_NAME";

const TEST_DATABASE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * 判断数据库名是否属于测试启动器当前 run。
 *
 * 前缀必须是启动器生成的 `noj_test_<runId>` 形态，且数据库名必须在前缀后
 * 还有下划线分隔的 shard 名；这样 `postgres`、开发库和仅共享字符串前缀的
 * 数据库都不会被误认为本 run 的 destructive 目标。
 */
export function isOwnedTestDatabaseName(
  databaseName: string,
  prefix: string,
): boolean {
  return /^noj_test_[A-Za-z0-9_]{4,32}$/.test(prefix) &&
    TEST_DATABASE_IDENTIFIER.test(databaseName) &&
    databaseName.startsWith(`${prefix}_`);
}

/** 测试侧必须显式提供的运行时密钥。 */
function assertRequiredTestEnvironment(): void {
  if (!Deno.env.get("DATABASE_URL")) {
    throw new Error(
      "拒绝执行数据库测试：DATABASE_URL 未设置；请使用测试启动器提供的专用 PostgreSQL 数据库",
    );
  }
  if (!Deno.env.get("JWT_SECRET")) {
    throw new Error(
      "拒绝执行数据库测试：JWT_SECRET 未设置；测试不得以 ignore 静默跳过必需依赖",
    );
  }
}

function databaseNameFromUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("拒绝执行测试数据库 reset：DATABASE_URL 不是合法 URL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new Error("拒绝执行测试数据库 reset：DATABASE_URL 缺少数据库名");
  }
  return databaseName;
}

/**
 * 校验当前连接指向启动器本次拥有的测试数据库。
 *
 * 任何 reset/truncate 都必须先调用本函数；不满足时明确拒绝，绝不触碰
 * 非启动器创建的数据库。
 *
 * @returns 当前测试数据库名
 */
export async function assertOwnedTestDatabase(): Promise<string> {
  assertRequiredTestEnvironment();
  if (Deno.env.get(TEST_DATABASE_OWNED_ENV) !== "1") {
    throw new Error(
      `拒绝执行测试数据库 reset：缺少 ${TEST_DATABASE_OWNED_ENV}=1 标记`,
    );
  }
  const databaseUrl = Deno.env.get("DATABASE_URL")!;
  const databaseName = databaseNameFromUrl(databaseUrl);
  const prefix = Deno.env.get(TEST_DATABASE_PREFIX_ENV)?.trim();
  if (!prefix) {
    throw new Error(
      `拒绝执行测试数据库 reset：${TEST_DATABASE_PREFIX_ENV} 必须由当前 run 显式提供且非空`,
    );
  }
  if (!/^noj_test_[A-Za-z0-9_]{4,32}$/.test(prefix)) {
    throw new Error(
      `拒绝执行测试数据库 reset：${TEST_DATABASE_PREFIX_ENV} 必须符合启动器的 noj_test_<runId> 格式`,
    );
  }
  if (!isOwnedTestDatabaseName(databaseName, prefix)) {
    throw new Error(
      `拒绝执行测试数据库 reset：数据库名 ${databaseName} 不属于测试 run ${prefix}`,
    );
  }
  const expectedName = Deno.env.get(TEST_DATABASE_NAME_ENV)?.trim();
  if (!expectedName) {
    throw new Error(
      `拒绝执行测试数据库 reset：${TEST_DATABASE_NAME_ENV} 必须由当前 run 显式提供`,
    );
  }
  if (expectedName !== databaseName) {
    throw new Error(
      `拒绝执行测试数据库 reset：当前数据库 ${databaseName} 与启动器声明的 ${expectedName} 不一致`,
    );
  }
  if (!isOwnedTestDatabaseName(expectedName, prefix)) {
    throw new Error(
      `拒绝执行测试数据库 reset：${TEST_DATABASE_NAME_ENV} 不属于测试 run ${prefix}`,
    );
  }
  const current = unwrapRows<{ current_database: string }>(
    (await getDb().execute(sql`SELECT current_database()`)) as never,
  )[0]?.current_database;
  if (current !== databaseName) {
    throw new Error(
      `拒绝执行测试数据库 reset：连接实际数据库 ${
        current ?? "<unknown>"
      } 与声明的 ${databaseName} 不一致`,
    );
  }
  return current;
}

/** 当前 schema 中需要清空的用户表（排除迁移记录表）。 */
async function listResetTables(): Promise<string[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT LIKE '__drizzle%'
    ORDER BY c.relname
  `);
  return unwrapRows<{ name: string }>(result as never).map((row) => row.name);
}

/** 清空当前 schema 的全部用户表（CASCADE 处理外键）。 */
async function truncateAllTables(): Promise<void> {
  const tables = await listResetTables();
  if (tables.length === 0) {
    throw new Error("测试数据库未发现任何用户表：请确认启动器已执行正式迁移");
  }
  const quoted = tables.map((table) => `"${table.replaceAll('"', '""')}"`);
  await getDb().execute(sql.raw(`TRUNCATE TABLE ${quoted.join(", ")} CASCADE`));
}

/**
 * 写入测试基础种子：root、RBAC、默认工作空间与评测镜像。
 *
 * 仅在测试数据库内调用；会同步清空 system-settings 进程内缓存。
 */
export async function seedTestDatabase(): Promise<void> {
  await assertOwnedTestDatabase();
  await ensureRootUser();
  await ensureRbacSeeds();
  await ensureDefaultWorkspace();

  // 保留 00_migrate_test 时代的三条默认镜像语义（旧测试依赖 judge-python）。
  const db = getDb();
  const now = new Date().toISOString();
  const images = [
    {
      id: "e0000000-0000-0000-0000-000000000001",
      image: "noj-judge-python",
      mode: "all_versions",
      kind: "evaluator",
      description: "Python 3.12 评测环境",
    },
    {
      id: "e0000000-0000-0000-0000-000000000002",
      image: "noj-evaluator-python",
      mode: "all_versions",
      kind: "evaluator",
      description: "Evaluator 运行时",
    },
    {
      id: "e0000000-0000-0000-0000-000000000003",
      image: "noj-solution-python",
      mode: "all_versions",
      kind: "solution",
      description: "Solution 运行时",
    },
  ];
  for (const image of images) {
    await db.insert(judgeImages).values({
      ...image,
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing();
  }
  // 生产初始化仍使用完整镜像清单；在测试库补齐 AI 镜像不改变旧断言。
  await seedJudgeImages();

  _resetSystemSettingsForTest();
}

/**
 * 清空当前测试数据库并恢复基础种子。
 *
 * 不执行迁移；迁移由测试启动器在模板数据库中完成。普通测试只调用本函数。
 */
export interface ResetDbForTestOptions {
  /** 真实 PostgreSQL 中刷新榜单物化视图；用于需验证刷新路径的用例。 */
  refreshRankings?: boolean;
}

export async function resetDbForTest(
  options: ResetDbForTestOptions = {},
): Promise<void> {
  await assertOwnedTestDatabase();
  await truncateAllTables();
  await seedTestDatabase();
  if (options.refreshRankings) {
    const { refreshRankingsView } = await import(
      "../../src/domains/query/services/rankings.ts"
    );
    await refreshRankingsView({ throwOnError: true });
  }
}

/**
 * bootstrap 测试数据库：执行正式迁移并写入种子。
 *
 * 仅测试启动器/显式 bootstrap 调用；普通 reset 不得调用本函数。
 */
export async function setupSchemaForTest(): Promise<void> {
  await assertOwnedTestDatabase();
  await runMigrations();
  await seedTestDatabase();
}
