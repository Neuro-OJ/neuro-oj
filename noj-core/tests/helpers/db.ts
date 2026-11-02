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
import { ensureRootUser } from "../../src/modules/access/identity/index.ts";
import {
  ensureRbacSeeds,
  seedJudgeImages,
} from "../../src/modules/platform/system/index.ts";
import {
  _resetSystemSettingsForTest,
} from "../../src/modules/platform/system/services/system-settings.ts";
import { ensureDefaultWorkspace } from "../../src/modules/access/workspace/index.ts";
import { countPhase, measurePhase } from "../../../scripts/lib/test-timing.ts";

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

/** reset 阶段名（P0 计时契约的一部分，报告按阶段聚合）。 */
const RESET_PHASE = {
  ownershipCheck: "core.reset.ownership-check",
  truncate: "core.reset.truncate",
  root: "core.reset.root",
  rbac: "core.reset.rbac",
  workspace: "core.reset.workspace",
  images: "core.reset.images",
  rankingsRefresh: "core.reset.rankings-refresh",
  invocations: "core.reset.invocations",
} as const;

/**
 * 清表策略开关：auto（默认，依赖序 DELETE，失败回退 TRUNCATE）/ truncate（旧路径）。
 *
 * auto 的理由见 clearResetTables：TRUNCATE 必须连带处理外键闭包里的空表，
 * 在本机 btrfs 上 86 个关系约 480ms；依赖序 DELETE 只需清掉真正有数据的表。
 * 保留 truncate 开关便于 A/B 对照或极端环境回滚。
 */
const RESET_STRATEGY_ENV = "NOJ_TEST_RESET_STRATEGY";

/**
 * 当前 schema 中的用户表及其是否已占用存储（排除迁移记录表）。
 *
 * `pg_relation_size > 0` 意味着该表当前可能有行：空表恒为 0，写入过数据的表
 * 至少占一个页。用它筛掉空表可以让 TRUNCATE 不必为 99 个关系重建 relfilenode
 * （在 btrfs/overlay 上约 5-9ms/关系），而"清空"语义完全不变：没有数据的表
 * 本来就没有可清的内容。
 */
async function listResetTables(): Promise<
  Array<{ name: string; hasData: boolean }>
> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT c.relname AS name,
      pg_relation_size(c.oid) > 0 AS has_data
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT LIKE '__drizzle%'
    ORDER BY c.relname
  `);
  return unwrapRows<{ name: string; has_data: boolean }>(result as never).map(
    (row) => ({ name: row.name, hasData: row.has_data }),
  );
}

/** 引用标识符（表名来自 pg_class，这里仍按标准双写转义）。 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** 读取 schema 内的外键边（child → parent），自引用边不计入排序。 */
async function loadForeignKeyEdges(): Promise<Array<[string, string]>> {
  const result = await getDb().execute(sql`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f'
      AND n.nspname = current_schema()
      AND child.relname <> parent.relname
  `);
  return unwrapRows<{ child: string; parent: string }>(result as never).map(
    (row) => [row.child, row.parent],
  );
}

/** 外键边缓存：schema 在一次测试进程内不变，只查一次。 */
let foreignKeyEdges: Promise<Array<[string, string]>> | undefined;

/** 依赖序 DELETE 失败一次后不再重试，避免每个用例重复付出失败代价。 */
let deleteStrategyDisabled = false;

/** 外键图存在环时只提示一次，避免每个 reset 都刷屏。 */
let cycleWarningEmitted = false;

/**
 * 计算 children-first 的 DELETE 顺序。
 *
 * 每轮挑出"没有任何剩余表引用它"的表先删，保证父行在被引用的子行之后才删除。
 * 若存在外键环导致无法收敛，返回空数组，由调用方回退 TRUNCATE。
 *
 * @param targets 需要清空的表
 * @param edges schema 内的外键边
 * @returns 删除顺序；无法排序时为空数组
 */
function orderTablesForDelete(
  targets: string[],
  edges: Array<[string, string]>,
): string[] {
  const remaining = new Set(targets);
  const related = edges.filter(([child, parent]) =>
    remaining.has(child) && remaining.has(parent)
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const referenced = new Set<string>();
    for (const [child, parent] of related) {
      if (remaining.has(child)) referenced.add(parent);
    }
    const batch = [...remaining]
      .filter((table) => !referenced.has(table))
      .sort();
    if (batch.length === 0) return [];
    for (const table of batch) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

/** 在一个事务里按依赖序清空目标表。 */
async function deleteTablesInOrder(order: string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (const table of order) {
      await tx.execute(sql.raw(`DELETE FROM ${quoteIdentifier(table)}`));
    }
  });
}

/** 旧路径：TRUNCATE ... CASCADE。 */
async function truncateTables(targets: string[]): Promise<void> {
  const quoted = targets.map(quoteIdentifier);
  await getDb().execute(sql.raw(`TRUNCATE TABLE ${quoted.join(", ")} CASCADE`));
}

/**
 * 清空当前 schema 中已有数据的用户表。
 *
 * 表数量为 0 仍视为迁移缺失（保持原有失败语义）；全部为空时不发语句。
 *
 * 默认走依赖序 DELETE 而不是 TRUNCATE：TRUNCATE 必须连带处理外键闭包里的
 * **空**表（parent 被 truncate 时，未被列出的引用表会让语句直接失败），本仓库
 * 的闭包接近全部 86 张表，在 btrfs/overlay 上每个关系重建 relfilenode 约
 * 5-9ms，实测 86 个关系约 480ms；依赖序 DELETE 只处理真正有数据的表（通常
 * 10 张），语义仍是"清空全部数据"：序列值本来就不在种子语义内（TRUNCATE 不带
 * RESTART IDENTITY 同样不重置），外键由 children-first 顺序保证，schema 内也
 * 没有 DELETE 触发器。任何一步失败（例如出现外键环）都在事务回滚后回退
 * TRUNCATE，保持旧语义；NOJ_TEST_RESET_STRATEGY=truncate 可强制旧路径。
 */
async function clearResetTables(): Promise<void> {
  const tables = await listResetTables();
  if (tables.length === 0) {
    throw new Error("测试数据库未发现任何用户表：请确认启动器已执行正式迁移");
  }
  const targets = tables.filter((table) => table.hasData).map((table) =>
    table.name
  );
  if (targets.length === 0) return;

  const forceTruncate =
    (Deno.env.get(RESET_STRATEGY_ENV) ?? "auto").trim().toLowerCase() ===
      "truncate";
  if (!forceTruncate && !deleteStrategyDisabled) {
    try {
      foreignKeyEdges ??= loadForeignKeyEdges();
      const order = orderTablesForDelete(targets, await foreignKeyEdges);
      if (order.length > 0) {
        await deleteTablesInOrder(order);
        return;
      }
      if (!cycleWarningEmitted) {
        cycleWarningEmitted = true;
        console.warn(
          "[test-db] 外键依赖图无法给出删除顺序（可能存在环），清表回退 TRUNCATE",
        );
      }
    } catch (error) {
      // 清表本身失败时事务已回滚（DELETE 未生效），随后用旧路径重做一遍；
      // 外键图查询失败则清掉缓存，避免把 rejected promise 永久留在进程里。
      foreignKeyEdges = undefined;
      deleteStrategyDisabled = true;
      console.warn(
        `[test-db] 依赖序 DELETE 清表失败，本进程回退 TRUNCATE：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  await truncateTables(targets);
}

/**
 * 写入兼容镜像：保留 00_migrate_test 时代的三条默认镜像语义（旧测试依赖
 * judge-python）。三条一次批量 insert，id 已存在时整条跳过。
 */
async function seedCompatJudgeImages(): Promise<void> {
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
  await db.insert(judgeImages).values(
    images.map((image) => ({ ...image, created_at: now, updated_at: now })),
  ).onConflictDoNothing();
}

/**
 * 恢复基础种子：root、RBAC、默认工作空间与评测镜像。
 *
 * 每一步单独计时，供性能报告归因；语义与逐条写入时完全一致。系统设置缓存
 * 仍走既有 reset 接口（_resetSystemSettingsForTest）。
 */
async function seedTestDatabaseContent(): Promise<void> {
  await measurePhase(RESET_PHASE.root, () => ensureRootUser());
  await measurePhase(RESET_PHASE.rbac, () => ensureRbacSeeds());
  await measurePhase(RESET_PHASE.workspace, () => ensureDefaultWorkspace());
  await measurePhase(RESET_PHASE.images, async () => {
    await seedCompatJudgeImages();
    // 生产初始化仍使用完整镜像清单；在测试库补齐 AI 镜像不改变旧断言。
    await seedJudgeImages();
  });
  _resetSystemSettingsForTest();
}

/**
 * 写入测试基础种子：root、RBAC、默认工作空间与评测镜像。
 *
 * 仅在测试数据库内调用；会同步清空 system-settings 进程内缓存。
 */
export async function seedTestDatabase(): Promise<void> {
  await measurePhase(
    RESET_PHASE.ownershipCheck,
    () => assertOwnedTestDatabase(),
  );
  await seedTestDatabaseContent();
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
  // 次数计数：报告用它区分"reset 变少"与"单次 reset 变快"。
  countPhase(RESET_PHASE.invocations, 1);
  await measurePhase(
    RESET_PHASE.ownershipCheck,
    () => assertOwnedTestDatabase(),
  );
  await measurePhase(RESET_PHASE.truncate, () => clearResetTables());
  await seedTestDatabaseContent();
  if (options.refreshRankings) {
    await measurePhase(RESET_PHASE.rankingsRefresh, async () => {
      const { refreshRankingsView } = await import(
        "../../src/modules/read-models/queries/services/rankings.ts"
      );
      await refreshRankingsView({ throwOnError: true });
    });
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
