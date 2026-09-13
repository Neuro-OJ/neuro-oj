import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getDb } from "./connection.ts";
import { dirname, resolve } from "jsr:@std/path@^1";
import { logger } from "../base/logging.ts";

const __dirname = dirname(new URL(import.meta.url).pathname);

/**
 * 迁移串行化用的 advisory lock 命名空间（int4 第一参数）。
 * 取值为 "NOJM" 的十六进制，便于在 pg_locks 中辨认。
 */
const MIGRATION_LOCK_NAMESPACE = 0x4e4f4a4d;

/** 获取迁移锁的最长等待时间（之后降级为"无锁迁移"并告警）。 */
const MIGRATION_LOCK_WAIT_MS = 5 * 60_000;
/** 重试间隔 */
const MIGRATION_LOCK_RETRY_MS = 2_000;

/**
 * 由 schema 名派生 advisory lock 的第二个键。
 *
 * 作用：让**不同 schema**（如测试分片 test_unit / test_db）互不阻塞，
 * 而**同一 schema** 的两个迁移器仍然串行。
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
interface LockConnection {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
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
 * 自己的连接，而测试模式连接池是 `max: 1`（见 connection.ts），预留唯一连接后
 * 迁移器永远拿不到连接 → **自死锁**（实测挂死 5 分钟）。
 * 因此这里建立一条**独立的单连接**专门持锁，主连接池保持可用。
 *
 * 等待策略：最多等 5 分钟（每 2s 重试一次 `pg_try_advisory_lock`）；超时后**仍然迁移**
 * 但记录 error —— 宁可让 DDL 竞争交由 PostgreSQL 自身锁解决（失败可见），
 * 也不要因为一把锁拿不到而让整个站点无法启动。
 */
async function withMigrationLock<T>(
  schema: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    // PGlite 模式不会走 runMigrations（由 schema-ddl 引导），无锁可加
    return await fn();
  }

  const secondKey = schemaLockKey(schema);
  let lockConn: LockConnection | null = null;
  try {
    lockConn = postgres(databaseUrl, { max: 1 }) as unknown as LockConnection;
  } catch (err) {
    logger.warn("创建迁移锁连接失败，改为无锁迁移", { err });
    return await fn();
  }

  let locked = false;
  try {
    const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const rows = await lockConn.unsafe(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [MIGRATION_LOCK_NAMESPACE, secondKey],
      ) as Array<{ locked: boolean }>;
      if (rows?.[0]?.locked === true) {
        locked = true;
        break;
      }
      logger.warn("另一个实例正在对同一 schema 执行数据库迁移，等待锁释放", {
        schema: schema ?? "public",
      });
      await new Promise((r) => setTimeout(r, MIGRATION_LOCK_RETRY_MS));
    }
    if (!locked) {
      logger.error(
        "等待迁移锁超时，将在无锁状态下继续迁移（可能与其它实例竞争，请确认只有一个迁移器在运行）",
        { schema: schema ?? "public" },
      );
    }
    return await fn();
  } finally {
    if (locked && lockConn) {
      await lockConn
        .unsafe("SELECT pg_advisory_unlock($1, $2)", [
          MIGRATION_LOCK_NAMESPACE,
          secondKey,
        ])
        .catch((err) => {
          logger.warn("释放迁移锁失败（连接关闭时会自动释放）", { err });
        });
    }
    try {
      // 关闭专用连接：即使解锁语句失败，连接结束也会释放会话级锁
      await lockConn?.end({ timeout: 5 });
    } catch {
      // 忽略关闭异常
    }
  }
}

/**
 * 在启动时执行数据库迁移。
 * 使用 Drizzle ORM 内置的 migrator 读取 drizzle/ 目录下的 SQL 迁移文件，
 * 按文件名排序执行。
 *
 * TEST_SCHEMA 分片模式：migrator 默认把迁移记录表（__drizzle_migrations）
 * 建在固定的 `drizzle` schema，各分片共享同一份记录会导致"已迁移"误判
 * 跳过（并行分片建表失败的根因）。设置 migrationsSchema 为 TEST_SCHEMA
 * 后，迁移记录表与业务表落在同一 schema，分片之间完全隔离。
 */
export async function runMigrations(): Promise<void> {
  try {
    const db = getDb();

    // 基于 import.meta.url 解析绝对路径，避免 CWD 依赖；
    // deno compile 后 import.meta.url 指向二进制路径，生产镜像通过
    // NOJ_MIGRATIONS_DIR 显式指定迁移目录。
    const migrationsFolder = Deno.env.get("NOJ_MIGRATIONS_DIR") ??
      resolve(__dirname, "../../../drizzle");
    const migrationsSchema = Deno.env.get("TEST_SCHEMA") || undefined;
    logger.info("开始数据库迁移", {
      migrations_folder: migrationsFolder,
      migrations_schema: migrationsSchema ?? "drizzle",
    });
    await withMigrationLock(migrationsSchema, () =>
      migrate(db, {
        migrationsFolder,
        ...(migrationsSchema ? { migrationsSchema } : {}),
      }));
    logger.info("数据库迁移完成");
  } catch (err) {
    logger.error("数据库迁移失败", { err });
    throw err;
  }
}
