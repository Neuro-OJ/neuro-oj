import { and, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { users } from "./../../../../shared/db/schema.ts";

/**
 * 根据用户名前缀搜索用户。
 *
 * 使用 ILIKE 模糊匹配，返回匹配用户的基本信息（不含敏感字段）。
 * 排除 root 系统用户（UID=0），限制返回条数防止滥用。
 *
 * @param query 搜索关键词（至少 2 字符）
 * @param limit 最大返回条数（默认 10，最大 20）
 */
export async function searchUsers(
  query: string,
  limit = 10,
): Promise<
  {
    id: string;
    username: string;
    avatar_url: string | null;
    created_at: string;
  }[]
> {
  if (query.length < 2) {
    return [];
  }
  if (limit > 20) limit = 20;

  const rows = await getDb()
    .select({
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
      created_at: users.created_at,
    })
    .from(users)
    .where(
      and(
        sql`${users.username} ILIKE ${`%${query}%`}`,
        sql`${users.id} <> '0'`, // 排除 root
        sql`${users.deleted_at} IS NULL`,
      ),
    )
    .limit(limit);

  return rows;
}
