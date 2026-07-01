import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { evaluationResults } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { submissions } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { users } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";

/**
 * 用户榜单条目。
 *
 * rank 为 1-based 全局名次，由 SQL 的 ROW_NUMBER() 在排序键上计算，
 * 保证跨分页的一致性（避免第 2 页首行 rank=1 等异常）。
 */
export interface RankingRow {
  rank: number;
  user_id: string;
  username: string;
  solved_count: number;
  total_submissions: number;
  /** 0–1 浮点数，保留 3 位小数（与 users.ts:getUserProfile 一致） */
  acceptance_rate: number;
}

export interface RankingsPage {
  data: RankingRow[];
  total: number;
}

const RANKING_DEFAULT_LIMIT = 50;
const RANKING_MAX_LIMIT = 100;

/**
 * 全站用户榜单。
 *
 * 排序键（确保稳定）：
 * 1. solved_count DESC（独立通过的题目数）
 * 2. acceptance_rate DESC（同题数下高效者靠前）
 * 3. total_submissions ASC（同分下提交少者靠前，避免"刷提交"）
 * 4. users.created_at ASC（最终 tiebreaker）
 *
 * 排除 root 系统用户（id='0'），仅展示至少有 1 道题通过的用户。
 * rank 由 SQL ROW_NUMBER() 在排序键上计算，确保跨分页一致。
 *
 * @throws {BadRequestError} page < 1 或 limit < 1 时
 */
export async function getGlobalRankings(params: {
  page: number;
  limit?: number;
}): Promise<RankingsPage> {
  if (!Number.isInteger(params.page) || params.page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  const limit = params.limit ?? RANKING_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestError("limit 必须为正整数");
  }
  const cappedLimit = Math.min(limit, RANKING_MAX_LIMIT);
  const offset = (params.page - 1) * cappedLimit;

  const db = getDb();

  // 1. 聚合 + ROW_NUMBER() 计算 rank，单次 SQL 完成
  const rows = await db.execute<{
    user_id: string;
    username: string;
    total_submissions: number;
    solved_count: number;
    accepted: number;
    acceptance_rate: number;
    rank: number;
  }>(sql`
    SELECT
      u.id AS user_id,
      u.username,
      COUNT(*)::int AS total_submissions,
      COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted')::int AS solved_count,
      COUNT(*) FILTER (WHERE er.status = 'Accepted')::int AS accepted,
      CASE WHEN COUNT(*) = 0 THEN 0
           ELSE ROUND(
             (COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*))::numeric,
             3
           )::float
      END AS acceptance_rate,
      ROW_NUMBER() OVER (
        ORDER BY
          COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted') DESC,
          CASE WHEN COUNT(*) = 0 THEN 0
               ELSE COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*)
          END DESC,
          COUNT(*) ASC,
          u.created_at ASC
      )::int AS rank
    FROM users u
    INNER JOIN submissions s ON s.user_id = u.id
    LEFT JOIN evaluation_results er ON er.submission_id = s.id
    WHERE u.id <> '0' AND s.status = 'finished'
    GROUP BY u.id, u.username, u.created_at
    HAVING COUNT(*) FILTER (WHERE er.status = 'Accepted') > 0
    ORDER BY rank
    LIMIT ${cappedLimit} OFFSET ${offset}
  `);

  const data: RankingRow[] = rows.map((row) => ({
    rank: Number(row.rank),
    user_id: row.user_id,
    username: row.username,
    solved_count: Number(row.solved_count),
    total_submissions: Number(row.total_submissions),
    acceptance_rate: Number(row.acceptance_rate),
  }));

  // 2. 总数查询（独立 SQL，复用 HAVING 条件确保计数一致）
  const totalResult = await db.execute<{ total: number }>(sql`
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT u.id
      FROM users u
      INNER JOIN submissions s ON s.user_id = u.id
      LEFT JOIN evaluation_results er ON er.submission_id = s.id
      WHERE u.id <> '0' AND s.status = 'finished'
      GROUP BY u.id
      HAVING COUNT(*) FILTER (WHERE er.status = 'Accepted') > 0
    ) AS ranked_users
  `);
  const total = Number(totalResult[0]?.total ?? 0);

  return { data, total };
}

/**
 * 获取指定用户在榜单中的位置。
 *
 * 返回该用户的完整榜单条目（含 rank），若用户未上榜（无通过记录）则返回 null。
 *
 * 实现：复用 getGlobalRankings 排序逻辑的子查询定位该用户的 rank 行。
 * 不直接用 WHERE user_id=? 简单过滤是因为需要保留相同的排序键以保证
 * rank 数值与榜单中的位置一致。
 *
 * @param userId 用户 UUID
 */
export async function getMyRanking(
  userId: string,
): Promise<RankingRow | null> {
  const db = getDb();

  const rows = await db.execute<{
    user_id: string;
    username: string;
    total_submissions: number;
    solved_count: number;
    accepted: number;
    acceptance_rate: number;
    rank: number;
  }>(sql`
    WITH ranked AS (
      SELECT
        u.id AS user_id,
        u.username,
        COUNT(*)::int AS total_submissions,
        COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted')::int AS solved_count,
        COUNT(*) FILTER (WHERE er.status = 'Accepted')::int AS accepted,
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE ROUND(
               (COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*))::numeric,
               3
             )::float
        END AS acceptance_rate,
        ROW_NUMBER() OVER (
          ORDER BY
            COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted') DESC,
            CASE WHEN COUNT(*) = 0 THEN 0
                 ELSE COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*)
            END DESC,
            COUNT(*) ASC,
            u.created_at ASC
        )::int AS rank
      FROM users u
      INNER JOIN submissions s ON s.user_id = u.id
      LEFT JOIN evaluation_results er ON er.submission_id = s.id
      WHERE u.id <> '0' AND s.status = 'finished'
      GROUP BY u.id, u.username, u.created_at
      HAVING COUNT(*) FILTER (WHERE er.status = 'Accepted') > 0
    )
    SELECT * FROM ranked WHERE user_id = ${userId} LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    rank: Number(row.rank),
    user_id: row.user_id,
    username: row.username,
    solved_count: Number(row.solved_count),
    total_submissions: Number(row.total_submissions),
    acceptance_rate: Number(row.acceptance_rate),
  };
}
