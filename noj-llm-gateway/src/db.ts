/**
 * noj-llm-gateway 数据库连接。
 */
import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

/** 创建 PostgreSQL 连接池。 */
export function createDb(databaseUrl: string): Db {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 未设置，无法连接数据库");
  }
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}
