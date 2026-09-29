import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { todayUtc } from "./../../../shared/base/dates.ts";
import { getDb } from "./../../../shared/db/connection.ts";
import { evaluationResults, submissions } from "./../../../shared/db/schema.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
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

import { getRedis } from "./../../../shared/mq/connection.ts";

// ── Redis 键名与 TTL ──
const REDIS_STATS_TOTAL_KEY = "noj:stats:total";
const REDIS_STATS_TODAY_PREFIX = "noj:stats:today:";
const STATS_CACHE_TTL_SECS = 10;

// ── 内存备用计数器（无 Redis 离线测试回退） ──
let fallbackTotal: number | null = null;
let fallbackTotalFullScore: number | null = null;
let fallbackTodayTotal: number | null = null;
let fallbackTodayFullScore: number | null = null;
let fallbackTodayDate: string | null = null;

/**
 * 尝试从 Redis 读取缓存快照。
 */
async function getFromRedis(key: string): Promise<StatsSnapshot | null> {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") return null;
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.total === "number" &&
      typeof parsed?.full_score === "number"
    ) {
      return {
        total: parsed.total,
        full_score: parsed.full_score,
        not_full_score: parsed.total - parsed.full_score,
      };
    }
  } catch {
    // Redis 故障时静默回退
  }
  return null;
}

/**
 * 尝试将快照写入 Redis。
 */
async function setInRedis(
  key: string,
  snapshot: { total: number; full_score: number },
): Promise<void> {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") return;
    await redis.set(
      key,
      JSON.stringify({
        total: snapshot.total,
        full_score: snapshot.full_score,
      }),
      "EX",
      STATS_CACHE_TTL_SECS,
    );
  } catch {
    // ignore
  }
}

// ── 公开 API ──

/**
 * 获取全站累计统计（Redis 缓存优先，DB 聚合兜底，支持多副本）。
 */
export async function getCachedTotalStats(): Promise<StatsSnapshot> {
  const cached = await getFromRedis(REDIS_STATS_TOTAL_KEY);
  if (cached) {
    fallbackTotal = cached.total;
    fallbackTotalFullScore = cached.full_score;
    return cached;
  }

  // 内存回退（若已有非空值且处于非 Redis 模式）
  if (fallbackTotal !== null && fallbackTotalFullScore !== null) {
    return {
      total: fallbackTotal,
      full_score: fallbackTotalFullScore,
      not_full_score: fallbackTotal - fallbackTotalFullScore,
    };
  }

  const { total: t, full_score: f } = await selectStatsRow();
  fallbackTotal = t;
  fallbackTotalFullScore = f;
  await setInRedis(REDIS_STATS_TOTAL_KEY, { total: t, full_score: f });

  return {
    total: t,
    full_score: f,
    not_full_score: t - f,
  };
}

/**
 * 获取今日统计（Redis 缓存优先，DB 聚合兜底，支持多副本）。
 * userId 提供时回退到 DB 查询（精确到人）。
 */
export async function getCachedTodayStats(
  userId?: string,
): Promise<StatsSnapshot> {
  if (userId) {
    return getTodayStatsFromDb(userId);
  }

  const today = todayUtc();
  const redisKey = `${REDIS_STATS_TODAY_PREFIX}${today}`;
  const cached = await getFromRedis(redisKey);
  if (cached) {
    fallbackTodayTotal = cached.total;
    fallbackTodayFullScore = cached.full_score;
    fallbackTodayDate = today;
    return cached;
  }

  if (
    fallbackTodayTotal !== null && fallbackTodayFullScore !== null &&
    fallbackTodayDate === today
  ) {
    return {
      total: fallbackTodayTotal,
      full_score: fallbackTodayFullScore,
      not_full_score: fallbackTodayTotal - fallbackTodayFullScore,
    };
  }

  const { total: t, full_score: f } = await selectStatsRow(
    gte(submissions.created_at, today),
  );
  fallbackTodayTotal = t;
  fallbackTodayFullScore = f;
  fallbackTodayDate = today;
  await setInRedis(redisKey, { total: t, full_score: f });

  return {
    total: t,
    full_score: f,
    not_full_score: t - f,
  };
}

/**
 * 新评测结果到达时失效 Redis 缓存并推送 SSE 事件（支持多副本同步）。
 * 在 saveEvaluationResult 成功后调用。
 */
export function applyNewResult(score: number | null, createdAt: string): void {
  const today = todayUtc();
  try {
    const redis = getRedis();
    if (redis.status === "ready") {
      void redis.del(
        REDIS_STATS_TOTAL_KEY,
        `${REDIS_STATS_TODAY_PREFIX}${today}`,
      );
    }
  } catch {
    // ignore
  }

  // 内存备用递增（保证无 Redis 离线测试正确性）
  if (fallbackTotal !== null) {
    fallbackTotal++;
    if (score !== null && score >= FULL_SCORE) fallbackTotalFullScore!++;
  }
  if (
    fallbackTodayTotal !== null && fallbackTodayDate === today &&
    createdAt >= today
  ) {
    fallbackTodayTotal++;
    if (score !== null && score >= FULL_SCORE) fallbackTodayFullScore!++;
  }

  // 写入 SSE 事件日志并发布 Redis 通知（fire-and-forget）
  void publishSseEvent(Channels.stats, { type: "stats:updated" });
}

/**
 * 重置缓存（测试用）。
 */
export function _resetStatsCacheForTest(): void {
  fallbackTotal = null;
  fallbackTotalFullScore = null;
  fallbackTodayTotal = null;
  fallbackTodayFullScore = null;
  fallbackTodayDate = null;
  try {
    const redis = getRedis();
    if (redis.status === "ready") {
      const today = todayUtc();
      void redis.del(
        REDIS_STATS_TOTAL_KEY,
        `${REDIS_STATS_TODAY_PREFIX}${today}`,
      );
    }
  } catch {
    // ignore
  }
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
