import { sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { submissions } from "./../../../shared/db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { users } from "./../../../shared/db/schema.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";
import { endedWindowCondition } from "./../../contest/index.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "query"]);

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
  avatar_url: string | null;
  solved_count: number;
  total_submissions: number;
  valid_submissions: number;
  /** 0–1 浮点数，保留 3 位小数（与 users.ts:getUserProfileAggregate 一致） */
  acceptance_rate: number;
}

/**
 * 榜单分页响应。
 */
export interface RankingsPage {
  data: RankingRow[];
  total: number;
}

const RANKING_DEFAULT_LIMIT = 50;
const RANKING_MAX_LIMIT = 100;

/** 视图存在性每次查询数据库，多副本不保存进程内业务缓存。 */
async function hasMaterializedView(): Promise<boolean> {
  const result = await getDb().execute(
    sql`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'user_rankings' AND relkind = 'm') AS exists`,
  );
  return Boolean(unwrapRows<{ exists: boolean }>(result as never)[0]?.exists);
}

/**
 * 物化视图是否**可信**（Handbook §3.5）。
 *
 * `user_rankings` 是版本化之前的视图（基于 `evaluation_results`），无法反映
 * 精确版本策略与分版本判定。判定规则：
 * - 视图不存在 → 不可信（PGlite / 未创建）；
 * - `query_projection_revisions('global')` 不存在 → 迁移前状态，视图与旧口径一致，可信；
 * - 存在且 `materialized_revision < data_revision` → **落后**，必须回退内联查询；
 * - 只有视图已覆盖当前 data_revision（由 7b 重建后的刷新流程记录）才可信。
 *
 * 因此版本化上线后（回填把 global data_revision 置为 1）榜单自动走内联路径，
 * 保证策略切换与重测立即可见，不依赖视图刷新。
 */
async function isRankingViewTrusted(): Promise<boolean> {
  if (!(await hasMaterializedView())) return false;
  try {
    const db = getDb();
    const result = await db.execute(
      sql`SELECT data_revision, materialized_revision FROM query_projection_revisions WHERE scope_key = 'global'`,
    );
    const rows = unwrapRows<
      { data_revision: number; materialized_revision: number }
    >(
      result as never,
    );
    const row = rows[0];
    if (!row) return false;
    return Number(row.materialized_revision) >= Number(row.data_revision);
  } catch {
    // 读不到 revision 表（视图存在但 schema 异常）→ 保守使用内联路径
    return false;
  }
}

/**
 * 从同一事务快照刷新榜单并登记覆盖 revision。
 * 数据库锁跨副本串行化刷新；只要 revision 落后，读取仍使用内联查询。
 */
export async function refreshRankingsView(): Promise<void> {
  try {
    if (!await hasMaterializedView()) return;
    await getDb().transaction(async (tx) => {
      // try-lock 避免并发结果为一次昂贵刷新排出长队。
      const acquired = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(622104) AS acquired`,
      );
      if (!unwrapRows<{ acquired: boolean }>(acquired as never)[0]?.acquired) {
        return;
      }
      await tx.execute(
        sql`INSERT INTO query_projection_revisions (scope_key, data_revision, materialized_revision) VALUES ('global', 0, 0) ON CONFLICT (scope_key) DO NOTHING`,
      );
      const revisionResult = await tx.execute(
        sql`SELECT data_revision FROM query_projection_revisions WHERE scope_key = 'global' FOR UPDATE`,
      );
      const revision = Number(
        unwrapRows<{ data_revision: number }>(revisionResult as never)[0]
          .data_revision,
      );
      await tx.execute(
        sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
      );
      await tx.execute(
        sql`UPDATE query_projection_revisions SET materialized_revision = ${revision} WHERE scope_key = 'global'`,
      );
    });
  } catch (err) {
    logger.error("物化视图刷新失败，读取继续使用内联成绩", { err });
  }
}

/** 保留测试调用入口；榜单读取和刷新已不保存进程内缓存。 */
export function _resetHasViewCacheForTest(): void {}

/** 两类提交共享有效成绩口径，运行状态不覆盖已有正式判定。 */
const rankingSources = sql`(
  SELECT user_id, problem_id, contest_id, status, is_valid, is_accepted FROM submissions
  UNION ALL
  SELECT user_id, paper_id AS problem_id, contest_id, status, is_valid, is_accepted FROM objective_submissions
)`;

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
  const useView = await isRankingViewTrusted();

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
      SELECT vr.user_id, vr.username, u.avatar_url,
             vr.total_submissions, vr.valid_submissions, vr.solved_count,
             vr.acceptance_rate, vr.rank
      FROM user_rankings vr
      LEFT JOIN users u ON u.id = vr.user_id
      ORDER BY vr.rank
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
        avatar_url: (row.avatar_url as string | null) ?? null,
        solved_count: Number(row.solved_count),
        total_submissions: Number(row.total_submissions),
        valid_submissions: Number(row.valid_submissions),
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
        u.avatar_url,
        COUNT(*)::int AS total_submissions,
        COUNT(*) FILTER (WHERE s.is_valid)::int AS valid_submissions,
        COUNT(DISTINCT s.problem_id) FILTER (
          WHERE ${sql`s.is_accepted = TRUE`}
            AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
        )::int AS solved_count,
        CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
             ELSE ROUND(
               (COUNT(*) FILTER (
                 WHERE ${sql`s.is_accepted = TRUE`}
                   AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
               )::float / COUNT(*) FILTER (WHERE s.is_valid))::numeric,
               3
             )::float
        END AS acceptance_rate,
        ROW_NUMBER() OVER (
          ORDER BY
            COUNT(DISTINCT s.problem_id) FILTER (
              WHERE ${sql`s.is_accepted = TRUE`}
                AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
            ) DESC,
            CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
                 ELSE COUNT(*) FILTER (
                   WHERE ${sql`s.is_accepted = TRUE`}
                     AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
                 )::float / COUNT(*) FILTER (WHERE s.is_valid)
            END DESC,
            COUNT(*) ASC,
            u.created_at ASC
        )::int AS rank
      FROM users u
      INNER JOIN ${rankingSources} s ON s.user_id = u.id
      LEFT JOIN contests c ON c.id = s.contest_id
      WHERE u.id <> '0' AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
      GROUP BY u.id, u.username, u.avatar_url, u.created_at
      HAVING COUNT(*) FILTER (
        WHERE ${sql`s.is_accepted = TRUE`}
          AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
      ) > 0
      ORDER BY rank
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT u.id
        FROM users u
        INNER JOIN ${rankingSources} s ON s.user_id = u.id
          LEFT JOIN contests c ON c.id = s.contest_id
        WHERE u.id <> '0' AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
        GROUP BY u.id
        HAVING COUNT(*) FILTER (
          WHERE ${sql`s.is_accepted = TRUE`}
            AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
        ) > 0
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
        avatar_url: (row.avatar_url as string | null) ?? null,
        solved_count: Number(row.solved_count),
        total_submissions: Number(row.total_submissions),
        valid_submissions: Number(row.valid_submissions),
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
  const useView = await isRankingViewTrusted();

  const rows = useView
    // 物化视图路径：直接 WHERE user_id=? 查询（LEFT JOIN users 取头像）
    ? await db.execute(sql`
      SELECT vr.user_id, vr.username, u.avatar_url,
             vr.total_submissions, vr.valid_submissions, vr.solved_count,
             vr.acceptance_rate, vr.rank
      FROM user_rankings vr
      LEFT JOIN users u ON u.id = vr.user_id
      WHERE vr.user_id = ${userId}
      LIMIT 1
    `)
    // 内联聚合回退路径：复用 getGlobalRankings 排序逻辑的子查询
    : await db.execute(sql`
      WITH ranked AS (
        SELECT
          u.id AS user_id,
          u.username,
          u.avatar_url,
          COUNT(*)::int AS total_submissions,
        COUNT(*) FILTER (WHERE s.is_valid)::int AS valid_submissions,
          COUNT(DISTINCT s.problem_id) FILTER (
            WHERE ${sql`s.is_accepted = TRUE`}
              AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
          )::int AS solved_count,
          CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
               ELSE ROUND(
                 (COUNT(*) FILTER (
                   WHERE ${sql`s.is_accepted = TRUE`}
                     AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
                 )::float / COUNT(*) FILTER (WHERE s.is_valid))::numeric,
                 3
               )::float
          END AS acceptance_rate,
          ROW_NUMBER() OVER (
            ORDER BY
              COUNT(DISTINCT s.problem_id) FILTER (
                WHERE ${sql`s.is_accepted = TRUE`}
                  AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
              ) DESC,
              CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
                   ELSE COUNT(*) FILTER (
                     WHERE ${sql`s.is_accepted = TRUE`}
                       AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
                   )::float / COUNT(*) FILTER (WHERE s.is_valid)
              END DESC,
              COUNT(*) ASC,
              u.created_at ASC
          )::int AS rank
        FROM users u
        INNER JOIN ${rankingSources} s ON s.user_id = u.id
          LEFT JOIN contests c ON c.id = s.contest_id
        WHERE u.id <> '0' AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
        GROUP BY u.id, u.username, u.avatar_url, u.created_at
        HAVING COUNT(*) FILTER (
          WHERE ${sql`s.is_accepted = TRUE`}
            AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
        ) > 0
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
    avatar_url: (row.avatar_url as string | null) ?? null,
    solved_count: Number(row.solved_count),
    total_submissions: Number(row.total_submissions),
    valid_submissions: Number(row.valid_submissions),
    acceptance_rate: Number(row.acceptance_rate),
  };
}
