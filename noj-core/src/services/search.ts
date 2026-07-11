import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";

/**
 * 全文搜索结果项——题目
 * display_id 由应用层拼接 `${type}${number}`（services/problems.ts:173）。
 */
export interface ProblemSearchHit {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
}

export interface ProblemSearchPage {
  items: ProblemSearchHit[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 全文搜索结果项——用户
 * 仅 admin 可调用（routes/search.ts 入口校验）。
 */
export interface UserSearchHit {
  id: string;
  username: string;
  email: string;
  role: string;
}

export interface UserSearchPage {
  items: UserSearchHit[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Drizzle db.execute() 在两种驱动下返回结构不同：
 * - postgres.js 返回数组
 * - PGlite 返回 `{ rows: [...], rowCount, ... }`
 * 此辅助函数统一返回数组，兼容两种驱动。
 */
// deno-lint-ignore no-explicit-any
function unwrapRows(result: any): Record<string, unknown>[] {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

/**
 * 题目全文搜索。
 *
 * 两路并行匹配 + ts_rank_cd 加权排序：
 * 1. tsvector @@ plainto_tsquery('simple', q)  —— GIN 索引 `idx_problems_search_vector`
 *    （覆盖英文 / 拉丁字符。PG 'simple' 词典不切分 CJK，故中文必须走 #2 兜底）
 * 2. title / description / (type||number) ILIKE '%q%' —— 中文与短字符串兜底
 *    （依赖 pg_trgm gin_trgm_ops 索引加速；无扩展时降级为顺序扫描）
 *
 * 服务端已校验 q 长度 1-100，page ≥ 1，limit ∈ [1, 100]。
 */
export async function searchProblems(
  q: string,
  page: number,
  limit: number,
): Promise<ProblemSearchPage> {
  const offset = (page - 1) * limit;
  const pattern = `%${q}%`;

  // 单条 SQL 同时返回 items + total：COUNT(*) OVER() 在 10 万行 OFFSET 2000 内 <100ms
  const result = await getDb().execute<{
    id: string;
    type: string;
    number: number;
    title: string;
    difficulty: string;
    rank: number | null;
    total: number;
  }>(sql`
    SELECT id,
           type,
           number,
           title,
           difficulty,
           ts_rank_cd(search_vector, query, 32) AS rank,
           COUNT(*) OVER() AS total
      FROM problems, plainto_tsquery('simple', ${q}) query
     WHERE search_vector @@ query
        OR title ILIKE ${pattern}
        OR description ILIKE ${pattern}
        OR (type || number::text) ILIKE ${pattern}
     ORDER BY rank DESC NULLS LAST, number ASC
     LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = unwrapRows(result) as Array<{
    id: string;
    type: string;
    number: number;
    title: string;
    difficulty: string;
    rank: number | null;
    total: number | string;
  }>;

  const items: ProblemSearchHit[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    number: r.number,
    display_id: `${r.type}${r.number}`,
    title: r.title,
    difficulty: r.difficulty,
  }));

  const total = rows.length > 0 ? Number(rows[0].total) : 0;

  return { items, total, page, limit };
}

/**
 * 用户搜索（仅 admin）。
 *
 * 通过 ILIKE 模糊匹配 username/email，
 * 排除 root（UID=0）系统用户。
 *
 * 不直接调用 `similarity()`——pg_trgm 在 PGlite 测试驱动中不可用，
 * 但生产 PG 仍受益于 gin_trgm_ops 索引加速 ILIKE '%q%' 模式匹配。
 * 排序策略：按 username/email 任一字段是否以 q 开头（精确前缀）优先，
 * 然后回退到任意位置匹配；最后按 created_at DESC 兜底。
 */
export async function searchUsers(
  q: string,
  page: number,
  limit: number,
): Promise<UserSearchPage> {
  const offset = (page - 1) * limit;
  const pattern = `%${q}%`;
  const prefix = `${q}%`;

  const result = await getDb().execute<{
    id: string;
    username: string;
    email: string;
    role: string;
    sort_key: number;
    total: number | string;
  }>(sql`
    SELECT id,
           username,
           email,
           role,
           CASE
             WHEN username ILIKE ${prefix} OR email ILIKE ${prefix} THEN 0
             ELSE 1
           END AS sort_key,
           COUNT(*) OVER() AS total
      FROM users
     WHERE id <> '0'
       AND (username ILIKE ${pattern} OR email ILIKE ${pattern})
     ORDER BY sort_key ASC, created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = unwrapRows(result) as Array<{
    id: string;
    username: string;
    email: string;
    role: string;
    sort_key: number;
    total: number | string;
  }>;

  const items: UserSearchHit[] = rows.map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role,
  }));

  const total = rows.length > 0 ? Number(rows[0].total) : 0;

  return { items, total, page, limit };
}
