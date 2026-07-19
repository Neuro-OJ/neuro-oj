import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.ts";
import { ALL_TABLES, SCHEMA_DDL, SCHEMA_INDEXES } from "./schema-ddl.ts";

let _db: ReturnType<typeof drizzlePg> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/** PGlite 全局单例——测试模式下使用，生产环境/CI 保持 null */
let _pgliteInstance: PGlite | null = null;
/** PGlite Schema 引导 Promise——首次 resetDbForTest() 时执行 */
let _bootstrapPromise: Promise<void> | null = null;

/**
 * DB 重置回调（避免循环依赖：其他模块注册清理回调，resetDbForTest 调用）。
 * 解决 system_settings 等模块的内存缓存与 DB TRUNCATE 不同步导致的测试污染。
 */
const _onDbResetCallbacks: Array<() => void> = [];

/** 注册测试重置回调（供 system-settings 等模块注册缓存清理函数） */
export function registerDbResetCallback(fn: () => void): void {
  _onDbResetCallbacks.push(fn);
}

/**
 * 判断当前是否为 PGlite 模式（无 DATABASE_URL 时自动启用）。
 */
function isPGliteMode(): boolean {
  return !Deno.env.get("DATABASE_URL");
}

/**
 * 获取 Drizzle ORM 数据库实例（单例模式）。
 *
 * 双模式驱动：
 * - `DATABASE_URL` 已设置 → postgres.js 连接外部 PostgreSQL（生产/CI）
 * - `DATABASE_URL` 未设置 → PGlite 内存 PostgreSQL（测试，零外部依赖）
 */
export function getDb() {
  if (_db) return _db;

  if (isPGliteMode()) {
    // PGlite 模式：全局单例，首次调用时创建
    if (!_pgliteInstance) {
      _pgliteInstance = new PGlite();
    }
    _db = drizzlePglite(
      _pgliteInstance,
      { schema },
    ) as unknown as ReturnType<typeof drizzlePg>;
    return _db;
  }

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("环境变量 DATABASE_URL 未设置");
  }

  try {
    const poolMax = parseInt(Deno.env.get("DATABASE_POOL_MAX") || "10", 10);
    const connectTimeout = parseInt(
      Deno.env.get("DATABASE_CONNECT_TIMEOUT") || "10",
      10,
    );
    const idleTimeout = parseInt(
      Deno.env.get("DATABASE_IDLE_TIMEOUT") || "300",
      10,
    );
    const maxLifetime = parseInt(
      Deno.env.get("DATABASE_MAX_LIFETIME") || "3600",
      10,
    );
    _client = postgres(databaseUrl, {
      max: poolMax,
      connect_timeout: connectTimeout,
      idle_timeout: idleTimeout,
      max_lifetime: maxLifetime,
    });
    _db = drizzlePg(_client, { schema });
    return _db;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("数据库初始化失败:", message);
    throw err;
  }
}

/**
 * 检查数据库连接状态。
 * PGlite 模式检查实例是否已初始化；postgres.js 模式执行 SELECT 1 验证。
 */
export async function checkDbHealth(): Promise<
  { ok: boolean; error?: string }
> {
  if (isPGliteMode()) {
    if (!_db) {
      return { ok: false, error: "未初始化" };
    }
    try {
      await _db.execute(sql`SELECT 1`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  if (!_client) {
    return { ok: false, error: "未初始化" };
  }
  if (!_db) {
    return { ok: false, error: "未初始化" };
  }

  try {
    await _db.execute(sql`SELECT 1`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * 重置数据库连接状态（测试用）。
 *
 * PGlite 模式：TRUNCATE 所有表 + re-seed root 用户和 judge image。
 * 保留 PGlite 实例（不清除），避免冷启动开销。
 *
 * postgres.js 模式：关闭连接池后清空单例（现有行为不变）。
 */
export async function resetDbForTest() {
  if (isPGliteMode()) {
    // PGlite 模式 — 确保实例已初始化
    if (!_pgliteInstance) {
      _pgliteInstance = new PGlite();
    }
    // 自动引导 Schema（首次调用时），await 确保引导完成
    if (!_bootstrapPromise) {
      _bootstrapPromise = (async () => {
        for (const ddl of SCHEMA_DDL) {
          await _pgliteInstance!.query(ddl);
        }
        for (const idx of SCHEMA_INDEXES) {
          await _pgliteInstance!.query(idx);
        }
      })();
    }
    await _bootstrapPromise;
    _db = null; // 清空 drizzle 包装，下次 getDb() 重新包装

    // TRUNCATE 保留 schema + re-seed
    const now = new Date().toISOString();
    try {
      await _pgliteInstance.query(
        `TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`,
      );
    } catch {
      // 某些测试可能只建了部分表，忽略
    }
    // Re-seed 必需数据
    try {
      await _pgliteInstance.query(
        `INSERT INTO users (id, username, email, password_hash, role, bio, created_at, updated_at)
         VALUES ('0', 'root', 'root@noj.local', '', 'admin', '', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // 表可能还没建
    }
    try {
      await _pgliteInstance.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
      await _pgliteInstance.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000002', 'noj-evaluator-python', 'all_versions', 'evaluator', 'Evaluator 运行时', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
      await _pgliteInstance.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000003', 'noj-solution-python', 'all_versions', 'solution', 'Solution 运行时', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // 表可能还没建
    }
    // 刷新物化视图（user_rankings，PGlite 不支持则忽略）
    try {
      await _pgliteInstance.query(
        `REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
      );
    } catch { /* PGlite 无物化视图支持 */ }
    _db = null;
    // 通知已注册模块重置缓存（如 system_settings 内存缓存）
    for (const fn of _onDbResetCallbacks) fn();
    return;
  }

  if (_client) {
    try {
      await _client.end();
    } catch {
      // 关闭连接失败不影响测试结果
    }
  }
  _db = null;
  // 测试模式（非 PGlite）：TRUNCATE 所有表 + re-seed 基础数据
  const now = new Date().toISOString();
  try {
    await getDb().execute(
      `TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`,
    );
  } catch {
    // 某些表可能不存在，忽略
  }
  try {
    // re-seed root 用户
    await getDb().execute(
      `INSERT INTO users (id, username, email, password_hash, role, bio, created_at, updated_at)
       VALUES ('0', 'root', 'root@noj.local', '', 'admin', '', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch { /* 忽略 */ }
  try {
    await getDb().execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await getDb().execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000002', 'noj-evaluator-python', 'all_versions', 'evaluator', 'Evaluator 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await getDb().execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000003', 'noj-solution-python', 'all_versions', 'solution', 'Solution 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch { /* 忽略 */ }
  // 刷新物化视图（TRUNCATE 后 user_rankings 需同步刷新）
  try {
    await getDb().execute(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
    );
  } catch { /* 可能没有物化视图 */ }
  _db = null;
  _client = null;
  // 通知已注册模块重置缓存（如 system_settings 内存缓存）
  for (const fn of _onDbResetCallbacks) fn();
}
