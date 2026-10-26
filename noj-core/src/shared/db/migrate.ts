import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getDb } from "./connection.ts";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "db"]);

const __dirname = dirname(fromFileUrl(import.meta.url));

/** 解析与生产迁移器相同的发布集迁移目录。 */
export function resolveMigrationsDirectory(): string {
  return Deno.env.get("NOJ_MIGRATIONS_DIR") ??
    resolve(__dirname, "../../../drizzle");
}

/**
 * 迁移串行化用的 advisory lock 命名空间（int4 第一参数）。
 * 取值为 "NOJM" 的十六进制，便于在 pg_locks 中辨认。
 */
const MIGRATION_LOCK_NAMESPACE = 0x4e4f4a4d;

/** 获取迁移锁的最长等待时间；超时即失败，绝不降级为"无锁迁移"。 */
const MIGRATION_LOCK_WAIT_MS = 5 * 60_000;
/** 重试间隔 */
const MIGRATION_LOCK_RETRY_MS = 2_000;

/**
 * 由 schema 名派生 advisory lock 的第二个键。
 *
 * 作用：让不同迁移锁域互不阻塞，而同一锁域的两个迁移器仍然串行。
 * 测试隔离使用独立数据库，不使用 `TEST_SCHEMA`。
 */
export function schemaLockKey(schema: string | undefined): number {
  // FNV-1a 32-bit，取正数以适配 int4 参数
  let h = 0x811c9dc5;
  for (const ch of schema ?? "public") {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

/** 专用锁连接（独立于主连接池，避免池耗尽导致自死锁）。 */
export interface LockConnection {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * 迁移锁获取过程的可注入依赖（供零外部依赖单测使用）。
 *
 * 生产默认实现见 `defaultMigrationLockDeps()`：真实 postgres.js 单连接、
 * 真实 `setTimeout` 与 `Date.now`、5 分钟等待上限、2 秒重试间隔。
 */
export interface MigrationLockDeps {
  /** 读取 DATABASE_URL（默认读进程环境变量）。 */
  getDatabaseUrl: () => string | undefined;
  /** 用连接串创建专用锁连接（默认 postgres.js `max: 1`，首次查询时才真正建连）。 */
  createConnection: (databaseUrl: string) => LockConnection;
  /** 重试等待（默认真实 setTimeout；测试注入假 sleep 不创建定时器）。 */
  sleep: (ms: number) => Promise<void>;
  /** 时钟（默认 Date.now），与 sleep 配合判断等待截止时间。 */
  now: () => number;
  /** 获取锁的最长等待时间（毫秒），超时即失败。 */
  waitTimeoutMs: number;
  /** 获取锁失败后的重试间隔（毫秒）。 */
  retryIntervalMs: number;
}

/**
 * 迁移锁无法获取。
 *
 * 迁移 DDL 必须在跨进程 advisory lock 保护下执行；未配置 DATABASE_URL、锁连接创建
 * 失败、`pg_try_advisory_lock` 报错、等待超时一律抛出本错误并终止迁移，禁止降级为
 * 无锁执行（否则两个迁移器会竞争 `__drizzle_migrations` 并重复施加同一条迁移）。
 */
export class MigrationLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationLockError";
  }
}

/** 把 unknown 异常转成可读文本（拼接错误信息时保留原始原因）。 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 生产默认依赖：真实 postgres.js 单连接、真实 setTimeout 与 Date.now。 */
function defaultMigrationLockDeps(): MigrationLockDeps {
  return {
    getDatabaseUrl: () => Deno.env.get("DATABASE_URL"),
    createConnection: (databaseUrl) =>
      postgres(databaseUrl, { max: 1 }) as unknown as LockConnection,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
    waitTimeoutMs: MIGRATION_LOCK_WAIT_MS,
    retryIntervalMs: MIGRATION_LOCK_RETRY_MS,
  };
}

/**
 * 在 advisory lock 保护下执行迁移。
 *
 * 背景（2026-09-12 架构评审 §4.5）：drizzle 的 migrator **不加任何跨进程锁**
 * （`drizzle-orm/pg-core/dialect.cjs` 只有建表 + 单事务）。当前单副本靠
 * compose `depends_on` 串行化是安全的，但多副本或人工并行执行时两个迁移器会竞争
 * `__drizzle_migrations` 并把同一条迁移重复施加。
 *
 * 实现要点（踩过的坑）：会话级 advisory lock 绑定**连接**，所以锁必须与迁移在
 * 同一条连接上才有效——但**不能**从主连接池 `reserve()`：drizzle 的迁移事务需要
 * 自己的连接，预留主连接池连接后迁移器可能无法取得连接。
 * 因此这里建立一条**独立的单连接**专门持锁，主连接池保持可用。
 *
 * 失败语义（2026-10-20 架构整治 P1b）：**拿不到锁必须失败，绝不调用 fn() 执行 DDL**。
 * - 未配置 DATABASE_URL：抛错；
 * - 创建专用锁连接失败 / `pg_try_advisory_lock` 抛错 / 等待超过上限：抛
 *   `MigrationLockError`，错误信息带 schema、等待时长与排查建议；
 * - 等待策略不变：最多 5 分钟、每 2 秒重试一次；超时改为失败而不是无锁继续；
 * - 无论成败，`finally` 都会解锁（已持有时）并关闭专用连接（会话级锁随连接释放）。
 *
 * @param schema 迁移锁域（undefined 表示 public）
 * @param fn 持锁成功后执行的迁移函数
 * @param overrides 依赖覆盖（仅测试注入假连接/假时钟；生产不传，默认行为不变）
 * @returns fn 的返回值
 * @throws {MigrationLockError} 无法获取迁移锁（含未配置 DATABASE_URL）
 */
export async function withMigrationLock<T>(
  schema: string | undefined,
  fn: () => Promise<T>,
  overrides: Partial<MigrationLockDeps> = {},
): Promise<T> {
  const schemaName = schema ?? "public";
  const deps: MigrationLockDeps = {
    ...defaultMigrationLockDeps(),
    ...overrides,
  };

  const databaseUrl = deps.getDatabaseUrl();
  if (!databaseUrl) {
    // 能走到这里的调用方都是要执行真实文件迁移的路径，缺 DATABASE_URL
    // 属于配置缺失，必须失败。
    throw new MigrationLockError(
      `未配置 DATABASE_URL，无法获取数据库迁移 advisory lock（schema=${schemaName}）。` +
        "迁移禁止在无锁状态下执行 DDL，已终止；请配置 DATABASE_URL 指向可用的 PostgreSQL 后重试。",
    );
  }

  const secondKey = schemaLockKey(schema);
  let lockConn: LockConnection;
  try {
    lockConn = deps.createConnection(databaseUrl);
  } catch (err) {
    throw new MigrationLockError(
      `创建迁移锁连接失败（schema=${schemaName}）：${errorText(err)}。` +
        "迁移必须持有 advisory lock 才能执行 DDL，已终止；请确认 DATABASE_URL 正确、" +
        "数据库可达且连接数未耗尽，并确认没有其它迁移器占用锁连接后重试。",
      { cause: err },
    );
  }

  let locked = false;
  try {
    const deadline = deps.now() + deps.waitTimeoutMs;
    while (deps.now() < deadline) {
      let rows: Array<{ locked: boolean }>;
      try {
        rows = await lockConn.unsafe(
          "SELECT pg_try_advisory_lock($1, $2) AS locked",
          [MIGRATION_LOCK_NAMESPACE, secondKey],
        ) as Array<{ locked: boolean }>;
      } catch (err) {
        throw new MigrationLockError(
          `执行 pg_try_advisory_lock 失败（schema=${schemaName}）：${
            errorText(err)
          }。` +
            "迁移必须持有 advisory lock 才能执行 DDL，已终止；请检查数据库连接是否被中断后重试。",
          { cause: err },
        );
      }
      if (rows?.[0]?.locked === true) {
        locked = true;
        break;
      }
      logger.warn("另一个实例正在对同一 schema 执行数据库迁移，等待锁释放", {
        schema: schemaName,
      });
      await deps.sleep(deps.retryIntervalMs);
    }
    if (!locked) {
      const waitSeconds = Math.round(deps.waitTimeoutMs / 1000);
      throw new MigrationLockError(
        `等待数据库迁移 advisory lock 超时（schema=${schemaName}，已等待 ${waitSeconds} 秒）：` +
          "另一个实例可能正在对同一 schema 执行迁移，或存在未释放锁的残留会话。" +
          "迁移必须持有 advisory lock 才能执行 DDL，本次未执行任何迁移操作；" +
          "请确认没有其它迁移器/锁连接占用，必要时查询 pg_locks 并结束残留会话后重试。",
      );
    }
    return await fn();
  } finally {
    if (locked) {
      await lockConn
        .unsafe("SELECT pg_advisory_unlock($1, $2)", [
          MIGRATION_LOCK_NAMESPACE,
          secondKey,
        ])
        .catch((err) => {
          // 释放失败不覆盖主流程错误；关闭专用连接同样会释放会话级锁。
          logger.warn("释放迁移锁失败（连接关闭时会自动释放）", { err });
        });
    }
    try {
      // 关闭专用连接：即使解锁语句失败，连接结束也会释放会话级锁
      await lockConn.end({ timeout: 5 });
    } catch {
      // 忽略关闭异常（进程退出/连接超时后由 PostgreSQL 释放会话级锁）
    }
  }
}

/**
 * 执行显式数据库迁移。
 * 由 `noj db migrate` / 开发 `dev-setup` 调用；HTTP 进程不调用此函数。
 * 使用 Drizzle ORM 内置的 migrator 读取发布集中的 SQL 迁移文件，
 * 按 journal 顺序执行。
 *
 * 拿不到迁移锁（未配置 DATABASE_URL、锁连接创建失败、等待超时）时抛
 * `MigrationLockError`，调用方必须按失败处理（CLI 与 dev-setup 均应终止）。
 */
export async function runMigrations(): Promise<void> {
  try {
    const db = getDb();

    // 基于 import.meta.url 解析绝对路径，避免 CWD 依赖；
    // deno compile 后 import.meta.url 指向二进制路径，生产镜像通过
    // NOJ_MIGRATIONS_DIR 显式指定迁移目录。
    const migrationsFolder = resolveMigrationsDirectory();
    logger.info("开始数据库迁移", {
      migrations_folder: migrationsFolder,
      migrations_schema: "drizzle",
    });
    await withMigrationLock(undefined, () => migrate(db, { migrationsFolder }));
    logger.info("数据库迁移完成");
  } catch (err) {
    logger.error("数据库迁移失败", { err });
    throw err;
  }
}
