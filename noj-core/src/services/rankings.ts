import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { evaluationResults } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { submissions } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { users } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";
import { unwrapRows } from "../lib/sql-rows.ts";

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
 * 检查 user_rankings 物化视图是否存在（postgres.js 模式下由 0020 迁移创建）。
 * PGlite 不支持 MATERIALIZED VIEW，因此 PGlite 模式恒返 false。
 *
 * 用 to_regclass 检测，避免每次榜单请求都抛"relation does not exist"错误。
 */
async function hasMaterializedView(): Promise<boolean> {
  try {
    const db = getDb();
    const result = await db.execute(
      sql`SELECT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'user_rankings'
      ) AS exists`,
    );
    const rows = unwrapRows<{ exists: boolean }>(result as never);
    return Boolean(rows[0]?.exists);
  } catch {
    return false;
  }
}

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
 *
 * PR-4：生产环境（postgres.js）下优先读 user_rankings 物化视图（PR-4 性能优化）。
 * PGlite 测试环境物化视图不可用，自动回退到原内联聚合。
 *
 * @throws {BadRequestError} page < 1 或 limit < 1 时
 */
/**
 * 刷新 user_rankings 物化视图。
 *
 * 评测结果写回后必须立即刷新；测试中直接 INSERT 后也需调用此函数。
 * 失败仅 console.error，不抛出。
 */
export async function refreshRankingsView(): Promise<void> {
  if (!(await hasMaterializedView())) return;
  try {
    const db = getDb();
    await db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
    );
  } catch (err) {
    console.error(
      "[rankings] 物化视图刷新失败（榜单可能短暂滞后）:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

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
  const useView = await hasMaterializedView();

  if (useView) {
    return readRankingsFromView(db, cappedLimit, offset);
  }
  return readRankingsInline(db, cappedLimit, offset);
}

/**
 * 从 user_rankings 物化视图读取（PR-4 主路径，postgres.js）。
 *
 * 视图已包含排好序的 rank 列，仅需分页 LIMIT/OFFSET。
 * 比内联聚合快 ~10x（10k 用户 / 100k 提交场景）。
 */
function readRankingsFromView(
  // deno-lint-ignore no-explicit-any -- postgres.js | PGlite 共享类型
  db: any,
  limit: number,
  offset: number,
): Promise<RankingsPage> {
  // db.execute<{ ... }> 需要具体类型；此处用 unknown 在 .map 时断言字段
  return Promise.all([
    db.execute(sql`
      SELECT user_id, username, total_submissions, solved_count,
             acceptance_rate, rank
      FROM user_rankings
      ORDER BY rank
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(
      sql`SELECT COUNT(*)::int AS total FROM user_rankings`,
    ),
  ]).then(([dataRes, totalRes]) => {
    const dataRows = unwrapRows<Record<string, unknown>>(dataRes as never);
    const totalRows = unwrapRows<{ total: number }>(totalRes as never);

    return {
      data: dataRows.map((row) => ({
        rank: Number(row.rank),
        user_id: row.user_id as string,
        username: row.username as string,
        solved_count: Number(row.solved_count),
        total_submissions: Number(row.total_submissions),
        acceptance_rate: Number(row.acceptance_rate),
      })),
      total: Number(totalRows[0]?.total ?? 0),
    };
  });
}

/**
 * 内联聚合查询（PGlite 测试回退路径，与原逻辑一致）。
 */
function readRankingsInline(
  // deno-lint-ignore no-explicit-any -- postgres.js | PGlite 共享类型
  db: any,
  limit: number,
  offset: number,
): Promise<RankingsPage> {
  return Promise.all([
    db.execute(sql`
      SELECT
        u.id AS user_id,
        u.username,
        COUNT(*)::int AS total_submissions,
        COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted')::int AS solved_count,
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
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
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
    `),
  ]).then(([dataRes, totalRes]) => {
    const dataRows = unwrapRows<Record<string, unknown>>(dataRes as never);
    const totalRows = unwrapRows<{ total: number }>(totalRes as never);

    return {
      data: dataRows.map((row: Record<string, unknown>) => ({
        rank: Number(row.rank),
        user_id: row.user_id as string,
        username: row.username as string,
        solved_count: Number(row.solved_count),
        total_submissions: Number(row.total_submissions),
        acceptance_rate: Number(row.acceptance_rate),
      })),
      total: Number(totalRows[0]?.total ?? 0),
    };
  });
}

/**
 * 获取指定用户在榜单中的位置。
 *
 * 返回该用户的完整榜单条目（含 rank），若用户未上榜（无通过记录）则返回 null。
 *
 * @param userId 用户 UUID
 */
export async function getMyRanking(
  userId: string,
): Promise<RankingRow | null> {
  const db = getDb();
  const useView = await hasMaterializedView();

  const rows = useView
    // 物化视图路径：直接 WHERE user_id=? 查询
    ? await db.execute(sql`
      SELECT user_id, username, total_submissions, solved_count,
             acceptance_rate, rank
      FROM user_rankings
      WHERE user_id = ${userId}
      LIMIT 1
    `)
    // 内联聚合回退路径：复用 getGlobalRankings 排序逻辑的子查询
    : await db.execute(sql`
      WITH ranked AS (
        SELECT
          u.id AS user_id,
          u.username,
          COUNT(*)::int AS total_submissions,
          COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted')::int AS solved_count,
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

  const resultRows = unwrapRows<Record<string, unknown>>(rows as never);
  const row = resultRows[0];
  if (!row) return null;

  return {
    rank: Number(row.rank),
    user_id: row.user_id as string,
    username: row.username as string,
    solved_count: Number(row.solved_count),
    total_submissions: Number(row.total_submissions),
    acceptance_rate: Number(row.acceptance_rate),
  };
}
