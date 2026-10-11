import { sql } from "drizzle-orm";
import {
  getDb,
  isInsideTestTransaction,
} from "./../../../shared/db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { submissions } from "./../../../shared/db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { users } from "./../../../shared/db/schema.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";
import {
  CONTEST_TIME_ISO_REGEX_SQL,
  endedWindowCondition,
} from "./../../contest/index.ts";
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

/** 榜单视图新鲜度检查结果。 */
export interface RankingViewFreshness {
  /** 物化视图是否存在（PGlite / 未重建时为 false）。 */
  exists: boolean;
  /** 是否可信（可安全走视图读取路径）。 */
  trusted: boolean;
  /**
   * 是否因**赛期边界**落后：上次刷新之后才有竞赛结束，视图内容
   * （当时按"未结束"排除了该竞赛提交）不再等于内联口径。
   */
  stale_by_boundary: boolean;
  data_revision: number | null;
  materialized_revision: number | null;
  materialized_at: string | null;
}

const VIEW_ABSENT: RankingViewFreshness = Object.freeze({
  exists: false,
  trusted: false,
  stale_by_boundary: false,
  data_revision: null,
  materialized_revision: null,
  materialized_at: null,
});

const VIEW_UNKNOWN: RankingViewFreshness = Object.freeze({
  exists: true,
  trusted: false,
  stale_by_boundary: false,
  data_revision: null,
  materialized_revision: null,
  materialized_at: null,
});

/**
 * 物化视图是否**可信**（Handbook §3.5；2026-10-11 复审问题 8）。
 *
 * 两个维度都必须满足：
 *
 * 1. **数据 revision**：`materialized_revision >= data_revision`，否则刷新前
 *    已有判定/策略变化，视图落后；
 * 2. **赛期边界**：榜单内容还依赖竞赛 `end_time`（`affect_global_ranking` 的竞赛
 *    结束后，其提交才计入全站榜）。时钟跨越 `end_time` **不会**改变 data_revision，
 *    因此必须比较"上次刷新时刻"与"刷新之后才结束的竞赛"：
 *
 *    ```sql
 *    materialized_at < c.end_time <= now()
 *      AND c.affect_global_ranking = TRUE
 *    ```
 *
 *    即存在该竞赛 → 视图落后（内联口径已把它计入，视图还没有）。
 *    `materialized_at IS NULL`（0110 之前的存量行 / 尚未成功刷新）**按落后处理**：
 *    无法证明视图覆盖了赛期边界。
 *
 * 视图不存在（PGlite / 未重建）、revision 行缺失或读取异常时一律不可信，
 * 读取回退内联查询；本判定不保存进程内缓存（多副本一致）。
 *
 * @returns 视图存在性、可信度与落后原因（不抛错：任何异常都按不可信处理）
 */
export async function inspectRankingView(): Promise<RankingViewFreshness> {
  if (!(await hasMaterializedView())) return VIEW_ABSENT;
  try {
    const db = getDb();
    const result = await db.execute(sql`
      SELECT
        r.data_revision,
        r.materialized_revision,
        r.materialized_at,
        (
          r.materialized_at IS NULL
          OR EXISTS (
            SELECT 1 FROM contests c
            WHERE c.affect_global_ranking = TRUE
              AND CASE
                -- 与内联查询的 endedWindowCondition 同一 fail-closed 语义：
                -- 形态非规范 ISO 的 end_time 视为"未结束"，不触发边界失效
                WHEN c.end_time ~ ${CONTEST_TIME_ISO_REGEX_SQL}
                 AND pg_input_is_valid(c.end_time, 'timestamptz')
                 AND pg_input_is_valid(r.materialized_at, 'timestamptz')
                THEN c.end_time::timestamptz > r.materialized_at::timestamptz
                 AND c.end_time::timestamptz <= now()
                ELSE FALSE
              END
          )
        ) AS boundary_stale
      FROM query_projection_revisions r
      WHERE r.scope_key = 'global'
    `);
    const rows = unwrapRows<{
      data_revision: number;
      materialized_revision: number;
      materialized_at: string | null;
      boundary_stale: boolean;
    }>(result as never);
    const row = rows[0];
    // 没有 revision 行 → 无法证明视图与当前口径一致（保守回退内联）
    if (!row) return VIEW_UNKNOWN;
    const staleByBoundary = row.boundary_stale === true;
    const revisionCovered = Number(row.materialized_revision) >=
      Number(row.data_revision);
    return {
      exists: true,
      trusted: revisionCovered && !staleByBoundary,
      stale_by_boundary: staleByBoundary,
      data_revision: Number(row.data_revision),
      materialized_revision: Number(row.materialized_revision),
      materialized_at: row.materialized_at === null
        ? null
        : String(row.materialized_at),
    };
  } catch {
    // 读不到 revision 表（视图存在但 schema 异常）→ 保守使用内联路径
    return VIEW_UNKNOWN;
  }
}

/**
 * 视图落后时从读取路径调度一次异步刷新（fire-and-forget）。
 *
 * 赛期边界是**时间**驱动而非写入驱动的：竞赛自然结束后没有任何业务写入来触发
 * 刷新，若只依赖结果写入后的刷新，榜单会长期停在过期视图上（复审问题 8）。
 * 刷新本身用 `pg_try_advisory_xact_lock` 串行，多副本并发读只会有一个真正刷新；
 * 刷新成功后 `materialized_at` 前移，判定转为可信，调度自然停止。
 */
function scheduleRankingsRefresh(freshness: RankingViewFreshness): void {
  if (!freshness.exists || freshness.trusted) return;
  void refreshRankingsView();
}

/**
 * 从同一事务快照刷新榜单，并登记其覆盖的 revision 与刷新时刻。
 * 数据库锁跨副本串行化刷新；只要 revision 或赛期边界落后，读取仍使用内联查询。
 *
 * **根因说明（2026-10-11 复审纠错）**：此前注释称
 * "`REFRESH MATERIALIZED VIEW CONCURRENTLY` 不允许在事务块内执行（PG 25001）"，
 * 该说法**不成立**——PG 16.15 实测 `BEGIN; REFRESH ... CONCURRENTLY; ROLLBACK;`
 * 成功，本函数正是在同一事务内完成「取锁 → 刷新 → 记账」。
 *
 * 真正会出问题的是**异步刷新与测试事务的 savepoint 交错**：本函数是结果写入后的
 * fire-and-forget 调用（`refreshRankingsView().catch(...)`），测试用例的长事务只有
 * 一条连接，异步刷新在其中创建/释放 savepoint 会与用例自身的 savepoint 记账交错
 * （表现为 `savepoint "noj_sp_N" does not exist` → `current transaction is aborted`
 * 的假失败）。修法是 `connection.ts` 把 savepoint 事务串行化并让记账错误正常抛出；
 * 本函数额外保留 `isInsideTestTransaction()` 短路，作为**测试适配**（测试期读取
 * 一律走内联路径，跳过刷新不改变被测语义，也避免真跑昂贵的物化视图重建）。
 */
export async function refreshRankingsView(): Promise<void> {
  if (isInsideTestTransaction()) return;
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
      // 刷新前取时刻：刷新期间新结束的竞赛保守地算作"未被覆盖"，
      // 会让下一次读取再刷新一次，而不是错误地把过期视图标为最新。
      const refreshedAt = new Date().toISOString();
      await tx.execute(
        sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
      );
      await tx.execute(
        sql`UPDATE query_projection_revisions SET materialized_revision = ${revision}, materialized_at = ${refreshedAt} WHERE scope_key = 'global'`,
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
  const freshness = await inspectRankingView();
  // 落后（revision 或赛期边界）时调度一次异步刷新；读取立即用内联路径保证正确
  scheduleRankingsRefresh(freshness);

  if (freshness.trusted) {
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
  const freshness = await inspectRankingView();
  scheduleRankingsRefresh(freshness);

  const rows = freshness.trusted
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
