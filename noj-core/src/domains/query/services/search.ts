/**
 * 全局搜索（issue #100）。
 *
 * - searchProblems: 题目搜索（默认仅 P 型，admin 可 includeU）
 * - searchUsers: 用户搜索（admin only，排除 root）
 *
 * SQL 策略：
 * - tsvector @@ websearch_to_tsquery 精确匹配（英文/数字分词）
 * - title/username/email ILIKE '%q%' 模糊兜底（中文及邮箱片段）
 * - 这些条件 OR，由 PG planner 选最优索引
 * - ts_headline 生成高亮 marker（[[HIGHLIGHT]]...[[/HIGHLIGHT]]），非 HTML 防 XSS
 */

import { sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { ForbiddenError } from "./../../../shared/base/errors.ts";

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

/**
 * 题目搜索的查询参数。
 */
export interface SearchProblemsParams {
  /** 搜索关键词 */
  q: string;
  /** 当前请求是否为管理员（决定是否可返回 U 型题目） */
  isAdmin: boolean;
  /** 管理员是否包含 U 型题目（仅 isAdmin=true 时生效） */
  includeU?: boolean;
  /** 是否额外返回总命中数 total */
  includeTotal?: boolean;
  /** 页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  limit: number;
}

/**
 * 题目搜索结果单条条目。
 */
export interface ProblemSearchItem {
  /** 题目 UUID */
  id: string;
  /** 题目类型（P=公开 / U=未公开） */
  type: string;
  /** 题目编号 */
  number: number;
  /** 展示用 ID（如 P1001） */
  display_id: string;
  /** 题目标题 */
  title: string;
  /** 难度 */
  difficulty: string;
  /** 相关性分值 */
  rank: number;
  /** 高亮片段（[[HIGHLIGHT]] 标记，非 HTML 防 XSS） */
  highlight: string;
}

/**
 * 题目搜索结果（列表 + 分页信息）。
 */
export interface SearchProblemsResult {
  /** 结果条目列表 */
  items: ProblemSearchItem[];
  /** 是否还有更多（下一页） */
  has_more: boolean;
  /** 总命中数（仅 includeTotal=true 时返回） */
  total?: number;
  /** 查询耗时（毫秒） */
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
  const { q, isAdmin, includeU = false, includeTotal = false, page, limit } =
    params;
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
      OR EXISTS (
        SELECT 1 FROM problem_tags pt
        JOIN tags t ON t.id = pt.tag_id
        WHERE pt.problem_id = p.id AND t.name ILIKE ${likeQ} ESCAPE '\\'
      )
    )
    AND (
      ${includeUType} = TRUE
      OR p.type = 'P'
    )
    ORDER BY rank DESC NULLS LAST, p.number ASC
    LIMIT ${limit + 1} OFFSET ${offset}
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

  let total: number | undefined;
  if (includeTotal) {
    const countRows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM problems p
      WHERE (
        p.search_vector @@ websearch_to_tsquery('simple', ${q})
        OR p.title ILIKE ${likeQ} ESCAPE '\\'
        OR (p.type || p.number::text) ILIKE ${likeQ} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM problem_tags pt
          JOIN tags t ON t.id = pt.tag_id
          WHERE pt.problem_id = p.id AND t.name ILIKE ${likeQ} ESCAPE '\\'
        )
      )
      AND (
        ${includeUType} = TRUE
        OR p.type = 'P'
      )
    `);
    const countResult = "rows" in countRows
      ? (countRows as { rows: { count: string }[] }).rows
      : (countRows as unknown as { count: string }[]);
    total = Number(countResult[0]?.count ?? 0);
  }
  const took_ms = Math.round(performance.now() - start);
  const has_more = resultRows.length > limit;

  const items: ProblemSearchItem[] = resultRows.slice(0, limit).map((r) => ({
    id: r.id,
    type: r.type,
    number: r.number,
    display_id: `${r.type}${r.number}`,
    title: r.title,
    difficulty: r.difficulty,
    rank: r.rank ?? 0,
    highlight: r.highlight,
  }));

  return { items, has_more, total, took_ms };
}

/**
 * 用户搜索的查询参数。
 */
export interface SearchUsersParams {
  /** 搜索关键词 */
  q: string;
  /** 是否管理员（admin only，非管理员在 service 层抛 ForbiddenError） */
  isAdmin: boolean;
  /** 是否额外返回总命中数 total */
  includeTotal?: boolean;
  /** 页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  limit: number;
}

/**
 * 用户搜索结果单条条目。
 */
export interface UserSearchItem {
  /** 用户 UUID */
  id: string;
  /** 用户名 */
  username: string;
  /** 邮箱 */
  email: string;
  /** 相关性分值 */
  rank: number;
  /** 头像 URL（可为空） */
  avatar_url: string | null;
  /** 高亮片段（[[HIGHLIGHT]] 标记） */
  highlight: string;
}

/**
 * 用户搜索结果（列表 + 分页信息）。
 */
export interface SearchUsersResult {
  /** 结果条目列表 */
  items: UserSearchItem[];
  /** 是否还有更多（下一页） */
  has_more: boolean;
  /** 总命中数（仅 includeTotal=true 时返回） */
  total?: number;
  /** 查询耗时（毫秒） */
  took_ms: number;
}

/**
 * 社区搜索结果单条条目。
 */
export interface CommunitySearchItem {
  /** 社区帖子 UUID */
  id: string;
  /** 公开 ID */
  public_id: string;
  /** 帖子类型：solution（题解）或 discussion（讨论） */
  type: "solution" | "discussion";
  /** 帖子标题 */
  title: string;
  /** 作者用户 UUID */
  author_id: string;
  /** 作者用户名 */
  author_username: string;
  /** 作者头像 URL（可为空） */
  author_avatar_url: string | null;
  /** 关联题目 UUID（可为空） */
  problem_id: string | null;
  /** 创建时间 */
  created_at: string;
  /** 相关性分值 */
  rank: number;
  /** 高亮片段（[[HIGHLIGHT]] 标记） */
  highlight: string;
}

/**
 * 搜索已发布的社区帖子（题解/讨论）。
 *
 * 仅返回 status='published' 且 type 为 solution/discussion 的帖子，
 * 对标题/内容/问题编号做 ILIKE 模糊匹配与 tsvector 全文检索，返回高亮片段。
 *
 * @param params 搜索参数（q、includeTotal、page、limit）
 * @returns 社区搜索结果（列表 + 分页信息 + 可选 total）
 */
export async function searchCommunity(
  params: { q: string; includeTotal?: boolean; page: number; limit: number },
): Promise<{
  items: CommunitySearchItem[];
  has_more: boolean;
  total?: number;
  took_ms: number;
}> {
  const db = getDb();
  const { q, includeTotal = false, page, limit } = params;
  const offset = (page - 1) * limit;
  const likeQ = `%${escapeLikePattern(q)}%`;
  const start = performance.now();
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT p.id, p.public_id, p.type, p.title, p.author_id, u.username AS author_username, u.avatar_url AS author_avatar_url,
      p.problem_id, p.created_at,
      ts_rank(to_tsvector('simple', coalesce(p.title, '') || ' ' || p.content), websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', coalesce(p.title, p.content), websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5') AS highlight
    FROM community_posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN problems problem ON problem.id = p.problem_id
    WHERE p.status = 'published'
      AND p.type IN ('solution', 'discussion')
      AND (p.title ILIKE ${likeQ} ESCAPE '\\' OR p.content ILIKE ${likeQ} ESCAPE '\\'
        OR p.problem_id ILIKE ${likeQ} ESCAPE '\\'
        OR (problem.type || problem.number::text) ILIKE ${likeQ} ESCAPE '\\'
        OR problem.title ILIKE ${likeQ} ESCAPE '\\'
        OR to_tsvector('simple', coalesce(p.title, '') || ' ' || p.content) @@ websearch_to_tsquery('simple', ${q}))
    ORDER BY rank DESC NULLS LAST, p.created_at DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `);
  const resultRows = "rows" in rows
    ? (rows as unknown as { rows: CommunitySearchItem[] }).rows
    : (rows as unknown as CommunitySearchItem[]);
  let total: number | undefined;
  if (includeTotal) {
    const countRows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM community_posts p
      LEFT JOIN problems problem ON problem.id = p.problem_id
      WHERE p.status = 'published' AND p.type IN ('solution', 'discussion')
        AND (p.title ILIKE ${likeQ} ESCAPE '\\' OR p.content ILIKE ${likeQ} ESCAPE '\\'
          OR p.problem_id ILIKE ${likeQ} ESCAPE '\\'
          OR (problem.type || problem.number::text) ILIKE ${likeQ} ESCAPE '\\'
          OR problem.title ILIKE ${likeQ} ESCAPE '\\'
          OR to_tsvector('simple', coalesce(p.title, '') || ' ' || p.content) @@ websearch_to_tsquery('simple', ${q}))
    `);
    const countResult = "rows" in countRows
      ? (countRows as { rows: { count: string }[] }).rows
      : (countRows as unknown as { count: string }[]);
    total = Number(countResult[0]?.count ?? 0);
  }
  return {
    items: resultRows.slice(0, limit).map((item) => ({
      ...item,
      rank: item.rank ?? 0,
    })),
    has_more: resultRows.length > limit,
    total,
    took_ms: Math.round(performance.now() - start),
  };
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
  const { q, includeTotal = false, page, limit } = params;
  const offset = (page - 1) * limit;
  const start = performance.now();
  const likeQ = `%${escapeLikePattern(q)}%`;

  const rows = await db.execute<{
    id: string;
    username: string;
    email: string;
    rank: number | null;
    avatar_url: string | null;
    highlight: string;
  }>(sql`
    SELECT
      u.id, u.username, u.email, u.avatar_url,
      ts_rank(u.search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', u.username, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]]'
      ) AS highlight
    FROM users u
    WHERE (
      u.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR u.username ILIKE ${likeQ} ESCAPE '\\'
      OR u.email ILIKE ${likeQ} ESCAPE '\\'
    )
    AND u.id <> '0'
    ORDER BY rank DESC NULLS LAST, u.username ASC
    LIMIT ${limit + 1} OFFSET ${offset}
  `);

  const resultRows = "rows" in rows
    ? (rows as {
      rows: Array<{
        id: string;
        username: string;
        email: string;
        rank: number | null;
        avatar_url: string | null;
        highlight: string;
      }>;
    }).rows
    : (rows as unknown as Array<{
      id: string;
      username: string;
      email: string;
      rank: number | null;
      avatar_url: string | null;
      highlight: string;
    }>);

  let total: number | undefined;
  if (includeTotal) {
    const countRows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM users u
      WHERE (
        u.search_vector @@ websearch_to_tsquery('simple', ${q})
        OR u.username ILIKE ${likeQ} ESCAPE '\\'
        OR u.email ILIKE ${likeQ} ESCAPE '\\'
      )
      AND u.id <> '0'
    `);
    const countResult = "rows" in countRows
      ? (countRows as { rows: { count: string }[] }).rows
      : (countRows as unknown as { count: string }[]);
    total = Number(countResult[0]?.count ?? 0);
  }
  const took_ms = Math.round(performance.now() - start);
  const has_more = resultRows.length > limit;

  const items: UserSearchItem[] = resultRows.slice(0, limit).map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    rank: r.rank ?? 0,
    avatar_url: r.avatar_url ?? null,
    highlight: r.highlight,
  }));

  return { items, has_more, total, took_ms };
}
