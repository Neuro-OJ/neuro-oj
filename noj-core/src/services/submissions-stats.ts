/**
 * Submissions 统计（PR-3 拆分）。
 *
 * 包含：
 * - getTotalStats：全站历史累计提交统计
 * - getTodayStats：当前用户的今日提交统计
 */

import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { evaluationResults, submissions } from "../db/schema.ts";
import { getDb } from "../db/connection.ts";
import type { TodayStats } from "./submissions-types.ts";

/**
 * 获取全站历史累计提交统计（不受时间范围限制）。
 *
 * - total：全站 submission 总数
 * - full_score：score >= 10000 的提交数
 * - not_full_score：其余
 */
export async function getTotalStats(): Promise<TodayStats> {
  const db = getDb();

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (where ${evaluationResults.score} >= 10000)::int`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    );

  const total = Number(row?.total ?? 0);
  const fullScore = Number(row?.full_score ?? 0);
  const notFullScore = total - fullScore;

  return {
    total,
    full_score: fullScore,
    not_full_score: notFullScore,
  };
}

/**
 * 获取今日提交统计（可选按 userId 过滤）。
 *
 * - total：今日（UTC 日期）提交总数
 * - full_score：今日 score >= 10000 的提交数
 * - not_full_score：今日其余
 */
export async function getTodayStats(userId?: string): Promise<TodayStats> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const conditions: SQL[] = [gte(submissions.created_at, today)];
  if (userId) conditions.push(eq(submissions.user_id, userId));

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (where ${evaluationResults.score} >= 10000)::int`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(...conditions));

  const total = Number(row?.total ?? 0);
  const fullScore = Number(row?.full_score ?? 0);
  const notFullScore = total - fullScore;

  return {
    total,
    full_score: fullScore,
    not_full_score: notFullScore,
  };
}
