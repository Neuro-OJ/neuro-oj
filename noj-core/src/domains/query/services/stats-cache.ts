import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { todayUtc } from "./../../../shared/base/dates.ts";
import { getDb } from "./../../../shared/db/connection.ts";
import { evaluationResults, submissions } from "./../../../shared/db/schema.ts";
import { Channels, publishSseEvent } from "../../../lib/event-bus.ts";
import { FULL_SCORE } from "./../../../shared/base/constants.ts";

/**
 * 统计快照：提交总数、满分数与未满分数的快照值。
 */
export interface StatsSnapshot {
  /** 提交总数 */
  total: number;
  /** 满分（score >= FULL_SCORE）提交数 */
  full_score: number;
  /** 未满分提交数（total - full_score） */
  not_full_score: number;
}

/**
 * 查询提交统计聚合行（总数 + 满分数）。
 */
async function selectStatsRow(
  where?: SQL | undefined,
): Promise<{ total: number; full_score: number }> {
  const db = getDb();
  // deno-lint-ignore no-explicit-any
  let query: any = db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (where ${evaluationResults.score} >= ${FULL_SCORE})::int`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    );
  if (where) query = query.where(where);
  // deno-lint-ignore no-explicit-any
  const [row]: any[] = await query;
  return {
    total: Number(row?.total ?? 0),
    full_score: Number(row?.full_score ?? 0),
  };
}

// ── 内存原子计数器 ──

let total: number | null = null;
let totalFullScore: number | null = null;

let todayTotal: number | null = null;
let todayFullScore: null | number = null;
let todayDate: string | null = null;

// ── 初始化（懒加载） ──

/**
 * 懒加载全站累计统计（内存缓存）。
 *
 * 若 total 已加载则直接返回；否则查询提交表聚合总数与满分数，
 * 写入模块级内存计数器。
 *
 * @returns 无返回值
 */
async function ensureTotal(): Promise<void> {
  if (total !== null) return;
  const { total: t, full_score: f } = await selectStatsRow();
  total = t;
  totalFullScore = f;
}

/**
 * 懒加载今日统计（内存缓存，按 UTC 日期区分）。
 *
 * 当天已加载且日期未改变时直接返回；否则查询今日提交的总数与满分数。
 *
 * @returns 无返回值
 */
async function ensureToday(): Promise<void> {
  const today = todayUtc();
  if (todayTotal !== null && todayDate === today) return;
  const { total: t, full_score: f } = await selectStatsRow(
    gte(submissions.created_at, today),
  );
  todayTotal = t;
  todayFullScore = f;
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
    if (score !== null && score >= FULL_SCORE) totalFullScore!++;
  }
  // 今日统计
  const today = todayUtc();
  if (todayTotal !== null && todayDate === today && createdAt >= today) {
    todayTotal++;
    if (score !== null && score >= FULL_SCORE) todayFullScore!++;
  }
  // 写入 SSE 事件日志并发布 Redis 通知（fire-and-forget）
  void publishSseEvent(Channels.stats, { type: "stats:updated" });
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

/**
 * 按用户精确查询今日统计（不经缓存，直接查库）。
 *
 * 与 ensureToday 不同，该路径针对指定用户的今日提交做 DB 查询，
 * 用于用户级统计（此场景较少，不做内存缓存）。
 *
 * @param userId 用户 UUID
 * @returns 该用户的今日统计快照
 */
async function getTodayStatsFromDb(userId: string): Promise<StatsSnapshot> {
  const today = todayUtc();
  const { total, full_score } = await selectStatsRow(
    and(gte(submissions.created_at, today), eq(submissions.user_id, userId)),
  );
  return { total, full_score, not_full_score: total - full_score };
}
