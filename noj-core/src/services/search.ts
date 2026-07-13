/**
 * 全局搜索（issue #100）。
 *
 * - searchProblems: 题目搜索（默认仅 P 型，admin 可 includeU）
 * - searchUsers: 用户搜索（admin only，排除 root）
 *
 * SQL 策略：
 * - tsvector @@ websearch_to_tsquery 精确匹配（英文/数字分词）
 * - title ILIKE '%q%' 模糊兜底（中文 trigram）
 * - 两者 OR，由 PG planner 选最优索引
 * - ts_headline 生成高亮 marker（[[HIGHLIGHT]]...[[/HIGHLIGHT]]），非 HTML 防 XSS
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { ForbiddenError } from "../lib/errors.ts";

/**
 * 转义 LIKE 模式中的元字符（reviewer issue 2）。
 *
 * PostgreSQL LIKE 默认将 `%` 视为"任意字符序列"、`_` 视为"任意单个字符"。
 * 用户输入 "50%off" 会变成 `%50%off%` 模式，意外匹配所有含 "50" 后跟任意字符再 "off" 的字符串。
 * 同样 "foo_bar" 会匹配 "foo1bar"、"foo-bar" 等。
 *
 * 配合 `ESCAPE '\'` 子句，转义后 `\%` / `\_` 表示字面 `%` / `_`，`\\` 表示字面 `\`。
 */
function escapeLikePattern(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll(
    "_",
    "\\_",
  );
}

export interface SearchProblemsParams {
  q: string;
  isAdmin: boolean;
  includeU?: boolean;
  page: number;
  limit: number;
}

export interface ProblemSearchItem {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
  rank: number;
  highlight: string;
}

export interface SearchProblemsResult {
  items: ProblemSearchItem[];
  total: number;
  took_ms: number;
}

/**
 * 搜索题目。
 *
 * 权限规则：
 * - isAdmin=false: 仅返回 type='P'
 * - isAdmin=true + includeU=true: 返回 U+P
 * - isAdmin=true + includeU 缺省: 仅返回 P（保持一致）
 */
export async function searchProblems(
  params: SearchProblemsParams,
): Promise<SearchProblemsResult> {
  const db = getDb();
  const { q, isAdmin, includeU = false, page, limit } = params;
  const offset = (page - 1) * limit;
  const includeUType = isAdmin && includeU;
  const start = performance.now();
  const likeQ = `%${escapeLikePattern(q)}%`;

  // 列表查询：tsvector + trigram 联合（display_id 走 ILIKE 兜底，命中 'P1001' 这类 ID 搜索）
  const rows = await db.execute<{
    id: string;
    type: string;
    number: number;
    title: string;
    difficulty: string;
    rank: number | null;
    highlight: string;
  }>(sql`
    SELECT
      p.id, p.type, p.number, p.title, p.difficulty,
      ts_rank(p.search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', p.title, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
      ) AS highlight
    FROM problems p
    WHERE (
      p.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR p.title ILIKE ${likeQ} ESCAPE '\\'
      OR (p.type || p.number::text) ILIKE ${likeQ} ESCAPE '\\'
    )
    AND (
      ${includeUType} = TRUE
      OR p.type = 'P'
    )
    ORDER BY rank DESC NULLS LAST, p.number ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // postgres.js 返回 array-like 支持 .map()，PGlite 返回 { rows }
  // 统一用 .rows 访问
  const resultRows = "rows" in rows
    ? (rows as {
      rows: Array<{
        id: string;
        type: string;
        number: number;
        title: string;
        difficulty: string;
        rank: number | null;
        highlight: string;
      }>;
    }).rows
    : (rows as unknown as Array<{
      id: string;
      type: string;
      number: number;
      title: string;
      difficulty: string;
      rank: number | null;
      highlight: string;
    }>);

  // COUNT 查询
  const countRows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM problems p
    WHERE (
      p.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR p.title ILIKE ${likeQ} ESCAPE '\\'
      OR (p.type || p.number::text) ILIKE ${likeQ} ESCAPE '\\'
    )
    AND (
      ${includeUType} = TRUE
      OR p.type = 'P'
    )
  `);

  const countResult = "rows" in countRows
    ? (countRows as { rows: { count: string }[] }).rows
    : (countRows as unknown as { count: string }[]);
  const total = Number(countResult[0]?.count ?? 0);
  const took_ms = Math.round(performance.now() - start);

  const items: ProblemSearchItem[] = resultRows.map((r) => ({
    id: r.id,
    type: r.type,
    number: r.number,
    display_id: `${r.type}${r.number}`,
    title: r.title,
    difficulty: r.difficulty,
    rank: r.rank ?? 0,
    highlight: r.highlight,
  }));

  return { items, total, took_ms };
}

export interface SearchUsersParams {
  q: string;
  isAdmin: boolean;
  page: number;
  limit: number;
}

export interface UserSearchItem {
  id: string;
  username: string;
  email: string;
  role: string;
  rank: number;
  highlight: string;
}

export interface SearchUsersResult {
  items: UserSearchItem[];
  total: number;
  took_ms: number;
}

/**
 * 搜索用户（admin only）。
 *
 * 必须 isAdmin=true。
 * 排除 root 用户（UID='0'）。
 *
 * 防御性鉴权（reviewer issue 3）：service 层加 `ForbiddenError` 兜底。
 * 正常调用应来自路由层 `requireAdmin` 中间件保护，但万一路由守卫缺失，
 * service 层 fail-closed 抛出 403，避免静默返回用户列表导致越权。
 */
export async function searchUsers(
  params: SearchUsersParams,
): Promise<SearchUsersResult> {
  // 防御性鉴权（fail-closed）：路由层若漏掉 admin 守卫，service 层兜底拒绝
  if (!params.isAdmin) {
    throw new ForbiddenError("用户搜索仅限管理员");
  }
  const db = getDb();
  const { q, page, limit } = params;
  const offset = (page - 1) * limit;
  const start = performance.now();
  const likeQ = `%${escapeLikePattern(q)}%`;

  const rows = await db.execute<{
    id: string;
    username: string;
    email: string;
    role: string;
    rank: number | null;
    highlight: string;
  }>(sql`
    SELECT
      u.id, u.username, u.email, u.role,
      ts_rank(u.search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', u.username, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]]'
      ) AS highlight
    FROM users u
    WHERE (
      u.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR u.username ILIKE ${likeQ} ESCAPE '\\'
    )
    AND u.id <> '0'
    ORDER BY rank DESC NULLS LAST, u.username ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const resultRows = "rows" in rows
    ? (rows as {
      rows: Array<{
        id: string;
        username: string;
        email: string;
        role: string;
        rank: number | null;
        highlight: string;
      }>;
    }).rows
    : (rows as unknown as Array<{
      id: string;
      username: string;
      email: string;
      role: string;
      rank: number | null;
      highlight: string;
    }>);

  const countRows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM users u
    WHERE (
      u.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR u.username ILIKE ${likeQ} ESCAPE '\\'
    )
    AND u.id <> '0'
  `);

  const countResult = "rows" in countRows
    ? (countRows as { rows: { count: string }[] }).rows
    : (countRows as unknown as { count: string }[]);
  const total = Number(countResult[0]?.count ?? 0);
  const took_ms = Math.round(performance.now() - start);

  const items: UserSearchItem[] = resultRows.map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role,
    rank: r.rank ?? 0,
    highlight: r.highlight,
  }));

  return { items, total, took_ms };
}
