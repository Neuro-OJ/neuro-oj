import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  categories,
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import { AppError } from "../lib/errors.ts";

/**
 * 仪表盘统计数据响应。
 */
export interface DashboardStats {
  total_users: number;
  total_problems: number;
  total_submissions: number;
  total_categories: number;
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
async function queryDashboardStats(): Promise<DashboardStats> {
  const db = getDb();
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    .toISOString();

  // 1. 用户统计：排除 root 系统用户（id='0'）
  const [userRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(sql`${users.id} <> '0'`);
  const totalUsers = Number(userRow?.count ?? 0);

  // 2. 题目统计：含 U 型和 P 型
  const [problemRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(problems);
  const totalProblems = Number(problemRow?.count ?? 0);

  // 3. 分类统计
  const [categoryRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories);
  const totalCategories = Number(categoryRow?.count ?? 0);

  // 4. 提交统计与通过率
  const [submissionStats] = await db
    .select({
      total: sql<number>`count(*)`,
      accepted: sql<
        number
      >`count(*) filter (where ${evaluationResults.status} = 'Accepted')`,
      total_judged: sql<
        number
      >`count(*) filter (where ${evaluationResults.status} is not null)`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      sql`${evaluationResults.submission_id} = ${submissions.id}`,
    );

  const totalSubmissions = Number(submissionStats?.total ?? 0);
  const totalAccepted = Number(submissionStats?.accepted ?? 0);
  const totalJudged = Number(submissionStats?.total_judged ?? 0);
  const acceptanceRate = totalJudged > 0
    ? Math.round((totalAccepted / totalJudged) * 1000) / 1000
    : 0;

  // 5. 待评测提交数
  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(sql`${submissions.status} = 'pending'`);
  const totalPending = Number(pendingRow?.count ?? 0);

  // 6. 24 小时统计
  const [recentSubmissionsRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(sql`${submissions.created_at} >= ${twentyFourHoursAgo}`);
  const recentSubmissions24h = Number(recentSubmissionsRow?.count ?? 0);

  const [activeUsersRow] = await db
    .select({ count: sql<number>`count(distinct ${submissions.user_id})` })
    .from(submissions)
    .where(sql`${submissions.created_at} >= ${twentyFourHoursAgo}`);
  const activeUsers24h = Number(activeUsersRow?.count ?? 0);

  return {
    total_users: totalUsers,
    total_problems: totalProblems,
    total_submissions: totalSubmissions,
    total_categories: totalCategories,
    total_accepted: totalAccepted,
    total_pending: totalPending,
    acceptance_rate: acceptanceRate,
    recent_submissions_24h: recentSubmissions24h,
    active_users_24h: activeUsers24h,
  };
}
