import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

let _db: ReturnType<typeof drizzle> | null = null;
let _client: ReturnType<typeof postgres> | null = null;
let _error: Error | null = null;

/**
 * 获取 Drizzle ORM 数据库实例（单例模式）。
 * 首次调用时初始化 postgres.js 连接。
 * 必须通过环境变量 `DATABASE_URL` 配置连接字符串，无默认值。
 */
export function getDb() {
  if (_db) return _db;
  if (_error) throw _error;

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    const err = new Error("环境变量 DATABASE_URL 未设置");
    _error = err;
    throw err;
  }

  try {
    _client = postgres(databaseUrl);
    _db = drizzle(_client, { schema });
    return _db;
  } catch (err) {
    _error = err instanceof Error ? err : new Error(String(err));
    console.error("数据库初始化失败:", _error.message);
    throw _error;
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
  if (_error) {
    return { ok: false, error: _error.message };
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
 */
export function resetDbForTest() {
  _db = null;
  _client = null;
  _error = null;
}
