import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL template
import { evaluationResults } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL template
import { problems } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL template
import { submissions } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL template
import { tags } from "../db/schema.ts";
// deno-lint-ignore no-unused-vars -- referenced inside raw SQL template
import { users } from "../db/schema.ts";
import { AppError } from "../lib/errors.ts";

/**
 * 仪表盘统计数据响应。
 */
export interface DashboardStats {
  total_users: number;
  total_problems: number;
  total_submissions: number;
  total_tags: number;
  total_accepted: number;
  total_pending: number;
  acceptance_rate: number;
  recent_submissions_24h: number;
  active_users_24h: number;
}

/**
 * 获取仪表盘统计指标。
 *
 * 执行 4 次独立查询聚合各表数据，服务层组合后返回。
 * 所有查询均在主键/索引上执行，复杂度 O(log N)。
 *
 * @throws {Error} 数据库连接异常时抛出
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  try {
    return await queryDashboardStats();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      "获取统计数据失败，请稍后重试",
      500,
      "DASHBOARD_STATS_ERROR",
    );
  }
}

/**
 * 实际执行统计查询的内部函数。
 * 由 getDashboardStats() 调用，异常由外层统一转换为 DASHBOARD_STATS_ERROR。
 */
// NOJ-084：5 秒基础缓存，避免管理首页反复全表 COUNT。
let _dashboardCache: { at: number; data: DashboardStats } | null = null;
const DASHBOARD_CACHE_TTL_MS = 5000;

function executeRow<T>(
  result: T[] | { rows: T[] },
): T | undefined {
  return Array.isArray(result) ? result[0] : result.rows[0];
}

async function queryDashboardStats(): Promise<DashboardStats> {
  const now = Date.now();
  if (_dashboardCache && now - _dashboardCache.at < DASHBOARD_CACHE_TTL_MS) {
    return _dashboardCache.data;
  }

  const db = getDb();
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // 原先 7 次串行 COUNT 合并为 1 次查询；子查询仍走各自表计数，
  // 提交侧聚合用一次扫描完成。
  const result = await db.execute<{
    total_users: string;
    total_problems: string;
    total_tags: string;
    total_submissions: string;
    total_accepted: string;
    total_judged: string;
    total_pending: string;
    recent_submissions_24h: string;
    active_users_24h: string;
  }>(sql`
    SELECT
      (SELECT count(*)::text FROM users WHERE id <> '0') AS total_users,
      (SELECT count(*)::text FROM problems) AS total_problems,
      (SELECT count(*)::text FROM tags) AS total_tags,
      count(*)::text AS total_submissions,
      count(*) FILTER (WHERE er.status = 'Accepted')::text AS total_accepted,
      count(*) FILTER (WHERE er.status IS NOT NULL)::text AS total_judged,
      count(*) FILTER (WHERE s.status = 'pending')::text AS total_pending,
      count(*) FILTER (WHERE s.created_at >= ${twentyFourHoursAgo})::text AS recent_submissions_24h,
      count(DISTINCT s.user_id) FILTER (WHERE s.created_at >= ${twentyFourHoursAgo})::text AS active_users_24h
    FROM submissions s
    LEFT JOIN evaluation_results er ON er.submission_id = s.id
  `);

  const row = executeRow(result);
  const totalUsers = Number(row?.total_users ?? 0);
  const totalProblems = Number(row?.total_problems ?? 0);
  const totalTags = Number(row?.total_tags ?? 0);
  const totalSubmissions = Number(row?.total_submissions ?? 0);
  const totalAccepted = Number(row?.total_accepted ?? 0);
  const totalJudged = Number(row?.total_judged ?? 0);
  const totalPending = Number(row?.total_pending ?? 0);
  const recentSubmissions24h = Number(row?.recent_submissions_24h ?? 0);
  const activeUsers24h = Number(row?.active_users_24h ?? 0);
  const acceptanceRate = totalJudged > 0
    ? Math.round((totalAccepted / totalJudged) * 1000) / 1000
    : 0;

  const data: DashboardStats = {
    total_users: totalUsers,
    total_problems: totalProblems,
    total_submissions: totalSubmissions,
    total_tags: totalTags,
    total_accepted: totalAccepted,
    total_pending: totalPending,
    acceptance_rate: acceptanceRate,
    recent_submissions_24h: recentSubmissions24h,
    active_users_24h: activeUsers24h,
  };
  _dashboardCache = { at: now, data };
  return data;
}

/** 测试用：清空仪表盘缓存。 */
export function _resetDashboardCacheForTest(): void {
  _dashboardCache = null;
}
