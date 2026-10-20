import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { submissions } from "../../../shared/db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL templates
import { users } from "../../../shared/db/schema.ts";
import {
  getDomainRankingRows,
  PUBLIC_DEFAULT_QUERY_SCOPE,
} from "./domain-query.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { CONTEST_TIME_ISO_REGEX_SQL } from "../../../modules/contests/index.ts";
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

/** 视图存在性每次查询数据库，多副本不保存进程内业务缓存。 */
async function hasMaterializedView(): Promise<boolean> {
  const result = await getDb().execute(
    sql`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'user_rankings' AND relkind = 'm') AS exists`,
  );
  return Boolean(unwrapRows<{ exists: boolean }>(result as never)[0]?.exists);
}

/** 榜单视图新鲜度检查结果。 */
export interface RankingViewFreshness {
  /** 物化视图是否存在（尚未迁移时为 false）。 */
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
 * 视图不存在、revision 行缺失或读取异常时一律不可信，
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
 * 从同一事务快照刷新榜单，并登记其覆盖的 revision 与刷新时刻。
 * 数据库锁跨副本串行化刷新；只要 revision 或赛期边界落后，读取仍使用内联查询。
 *
 * **覆盖时刻取数据库事务时钟**（2026-10-11 复审问题 4）：`materialized_at` 来自
 * 同一事务内的 `transaction_timestamp()`（规范化为 ISO 8601 UTC，毫秒精度），
 * 与视图定义里 `now()` 的求值时刻完全一致。不能用应用 `new Date()`：刷新事务若
 * 被行锁阻塞在赛期边界两侧，应用时钟会让"按赛前口径生成"的视图被误判为可信。
 *
 * **根因说明（2026-10-11 复审纠错）**：此前注释称
 * "`REFRESH MATERIALIZED VIEW CONCURRENTLY` 不允许在事务块内执行（PG 25001）"，
 * 该说法**不成立**——PG 16.15 实测 `BEGIN; REFRESH ... CONCURRENTLY; ROLLBACK;`
 * 成功，本函数正是在同一事务内完成「取锁 → 刷新 → 记账」。
 *
 * 调用方应等待本函数完成，以便结果写入路径能够观测刷新是否已结束；刷新失败
 * 在本函数内部记录并降级到内联榜单，不影响主写入结果。
 */
export interface RefreshRankingsOptions {
  /** 测试 reset 必须观测刷新失败；生产默认记录并回退内联查询。 */
  throwOnError?: boolean;
}

export async function refreshRankingsView(
  options: RefreshRankingsOptions = {},
): Promise<void> {
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
        sql`SELECT data_revision,
              to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transaction_iso
            FROM query_projection_revisions WHERE scope_key = 'global' FOR UPDATE`,
      );
      const revisionRow = unwrapRows<
        { data_revision: number; transaction_iso: string }
      >(revisionResult as never)[0];
      const revision = Number(revisionRow.data_revision);
      // 覆盖时刻必须取**数据库事务时钟**（`transaction_timestamp()`），
      // 而不是应用 `new Date()`（2026-10-11 复审问题 4）：
      // 视图定义里的 `now()` 就是本事务的 `transaction_timestamp()`（事务开始即固定），
      // 若刷新事务在赛前开始、被 revision 行锁阻塞到赛后再继续，应用时钟会落到
      // 边界另一侧，使"按赛前口径生成"的视图被误判为可信。取同一事务时钟后，
      // `inspectRankingView()` 的 `materialized_at < end_time <= now()` 必然与视图
      // 内容口径一致。
      // 格式必须规范化为 `YYYY-MM-DDTHH:MM:SS.mmmZ`：边界判定与内联查询共用
      // 同一 ISO 形态守卫，非规范形态会被 fail-closed 视为"未结束"。
      const refreshedAt = String(revisionRow.transaction_iso);
      await tx.execute(
        sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
      );
      await tx.execute(
        sql`UPDATE query_projection_revisions SET materialized_revision = ${revision}, materialized_at = ${refreshedAt} WHERE scope_key = 'global'`,
      );
    });
  } catch (err) {
    logger.error("物化视图刷新失败，读取继续使用内联成绩", { err });
    if (options.throwOnError) throw err;
  }
}

/** 保留测试调用入口；榜单读取和刷新已不保存进程内缓存。 */
export function _resetHasViewCacheForTest(): void {}

/** 默认域兼容榜单始终采用当前授权事实，旧全域物化视图不用于对外读取。 */
export async function getGlobalRankings(
  params: { page: number; limit?: number },
): Promise<RankingsPage> {
  return await getDomainRankingRows(PUBLIC_DEFAULT_QUERY_SCOPE, params);
}

/** 当前用户在默认域公开榜的位置，私有域记录不会提升这个名次。 */
export async function getMyRanking(userId: string): Promise<RankingRow | null> {
  return (await getDomainRankingRows(PUBLIC_DEFAULT_QUERY_SCOPE, {
    page: 1,
    limit: 1,
    userId,
  })).data[0] ?? null;
}
