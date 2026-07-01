import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

let _db: ReturnType<typeof drizzle> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/**
 * 获取 Drizzle ORM 数据库实例（单例模式）。
 * 首次调用时初始化 postgres.js 连接。
 * 必须通过环境变量 `DATABASE_URL` 配置连接字符串，无默认值。
 *
 * 注意：不在模块级别缓存连接错误，启动期 DB 暂不可用时让调用方
 * 收到原始错误，DB 恢复后下一次调用即可成功重连。
 */
export function getDb() {
  if (_db) return _db;

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("环境变量 DATABASE_URL 未设置");
  }

  try {
    // 连接池大小可通过环境变量配置，默认 10
    const poolMax = parseInt(Deno.env.get("DATABASE_POOL_MAX") || "10", 10);
    // connection_timeout / idle_timeout / max_lifetime 显式设定，避免
    // npm 兼容层下 postgres.js 连接管理异常导致首次查询耗时数秒
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
    _db = drizzle(_client, { schema });
    return _db;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("数据库初始化失败:", message);
    throw err;
  }
}

/**
 * 检查数据库连接状态。
 * 执行轻量查询（SELECT 1）验证连接实际可用。
 * 返回 { ok: true } 或 { ok: false, error: string }。
 */
export async function checkDbHealth(): Promise<
  { ok: boolean; error?: string }
> {
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
 * 关闭 postgres.js 连接池后清空单例，避免连接泄漏。
 */
export async function resetDbForTest() {
  if (_client) {
    try {
      await _client.end();
    } catch {
      // 关闭连接失败不影响测试结果
    }
  }
  _db = null;
  _client = null;
}
