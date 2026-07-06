import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { evaluationResults, submissions } from "../db/schema.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";

export interface StatsSnapshot {
  total: number;
  full_score: number;
  not_full_score: number;
}

// ── 内存原子计数器 ──

let total: number | null = null;
let totalFullScore: number | null = null;

let todayTotal: number | null = null;
let todayFullScore: null | number = null;
let todayDate: string | null = null;

// ── 初始化（懒加载） ──

async function ensureTotal(): Promise<void> {
  if (total !== null) return;
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
  total = Number(row?.total ?? 0);
  totalFullScore = Number(row?.full_score ?? 0);
}

async function ensureToday(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (todayTotal !== null && todayDate === today) return;
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
    )
    .where(gte(submissions.created_at, today));
  todayTotal = Number(row?.total ?? 0);
  todayFullScore = Number(row?.full_score ?? 0);
  todayDate = today;
}

// ── 公开 API ──

/**
 * 获取全站累计统计（内存缓存，懒加载）。
 */
export async function getCachedTotalStats(): Promise<StatsSnapshot> {
  await ensureTotal();
  return {
    total: total!,
    full_score: totalFullScore!,
    not_full_score: total! - totalFullScore!,
  };
}

/**
 * 获取今日统计（内存缓存，懒加载）。
 * userId 提供时回退到 DB 查询（精确到人）。
 */
export async function getCachedTodayStats(
  userId?: string,
): Promise<StatsSnapshot> {
  if (userId) {
    // 用户级统计场景较少，不做缓存
    return getTodayStatsFromDb(userId);
  }
  await ensureToday();
  return {
    total: todayTotal!,
    full_score: todayFullScore!,
    not_full_score: todayTotal! - todayFullScore!,
  };
}

/**
 * 新评测结果到达时原子递增计数器并推送 SSE 事件。
 * 在 saveEvaluationResult 成功后调用。
 */
export function applyNewResult(score: number | null, createdAt: string): void {
  // 全站累计
  if (total !== null) {
    total++;
    if (score !== null && score >= 10000) totalFullScore!++;
  }
  // 今日统计
  const today = new Date().toISOString().slice(0, 10);
  if (todayTotal !== null && todayDate === today && createdAt >= today) {
    todayTotal++;
    if (score !== null && score >= 10000) todayFullScore!++;
  }
  // 推送 SSE 事件（fire-and-forget）
  publishEvent(Channels.stats, JSON.stringify({ type: "stats:updated" }));
}

/**
 * 重置缓存（测试用）。
 */
export function _resetStatsCacheForTest(): void {
  total = null;
  totalFullScore = null;
  todayTotal = null;
  todayFullScore = null;
  todayDate = null;
}

// ── 内部 DB 查询（备选路径） ──

async function getTodayStatsFromDb(userId: string): Promise<StatsSnapshot> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
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
    .where(
      and(gte(submissions.created_at, today), eq(submissions.user_id, userId)),
    );
  const t = Number(row?.total ?? 0);
  const f = Number(row?.full_score ?? 0);
  return { total: t, full_score: f, not_full_score: t - f };
}
