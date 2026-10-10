import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { todayUtc } from "./../../../shared/base/dates.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  contests,
  evaluationAttempts,
  submissions,
} from "./../../../shared/db/schema.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
import { FULL_SCORE } from "./../../../shared/base/constants.ts";
import { endedWindowCondition } from "./../../contest/index.ts";

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
 * 查询提交统计聚合行（总数 + 满分有效提交数）。
 *
 * - 总数：按提交计数（一条提交在多个版本上评测仍只算一次）；
 * - 满分数：按**有效成绩投影**计数（`is_valid` + 有效尝试分数 = 满分），
 *   不再读 `evaluation_results`——旧表只有最近一次结果，且即将随存量收尾删除。
 * 赛中数据隔离（DL-02/DL-03）：排除任何未结束竞赛中的提交记录。
 */
async function selectStatsRow(
  where?: SQL | undefined,
): Promise<{ total: number; full_score: number }> {
  const db = getDb();
  const secrecyCondition = sql`(
    ${submissions.contest_id} IS NULL OR (
      ${contests.affect_global_ranking} = TRUE AND
      ${endedWindowCondition(contests.end_time)}
    )
  )`;
  // deno-lint-ignore no-explicit-any
  const query: any = db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (
        where ${submissions.is_valid} = TRUE
          AND ${evaluationAttempts.score} >= ${FULL_SCORE}
      )::int`,
    })
    .from(submissions)
    // 有效成绩指针指向的已完成正式判定（无效/迁移未知版本时指针为空 → 不计满分）
    .leftJoin(
      evaluationAttempts,
      eq(evaluationAttempts.id, submissions.effective_attempt_id),
    )
    .leftJoin(
      contests,
      eq(contests.id, submissions.contest_id),
    )
    .where(where ? and(secrecyCondition, where) : secrecyCondition);
  // deno-lint-ignore no-explicit-any
  const [row]: any[] = await query;
  return {
    total: Number(row?.total ?? 0),
    full_score: Number(row?.full_score ?? 0),
  };
}

import { getRedis } from "./../../../shared/mq/connection.ts";

// ── Redis 键名与 TTL ──
//
// 缓存键包含**全局投影 revision**（Handbook §3.5）：策略切换/判定替换会递增
// `query_projection_revisions.global.data_revision`，从而立即换到新键读取，
// 不依赖 TTL 到期，也不依赖任何进程内状态（多副本安全）。
const REDIS_STATS_TOTAL_PREFIX = "noj:stats:total:r";
const REDIS_STATS_TODAY_PREFIX = "noj:stats:today:";
const STATS_CACHE_TTL_SECS = 10;

/** 读取全局投影 revision（读不到时按 0 处理，等同"从未变更"）。 */
async function currentGlobalRevision(): Promise<number> {
  try {
    const db = getDb();
    const result = await db.execute(
      sql`SELECT data_revision FROM query_projection_revisions WHERE scope_key = 'global'`,
    );
    const rows = unwrapRows<{ data_revision: number }>(result as never);
    const value = rows[0]?.data_revision;
    return value == null ? 0 : Number(value);
  } catch {
    return 0;
  }
}

/** 全局累计统计的 Redis 键（含 revision）。 */
async function totalStatsKey(): Promise<string> {
  return `${REDIS_STATS_TOTAL_PREFIX}${await currentGlobalRevision()}`;
}

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
 *
 * 无进程内计数器：缓存未命中（或 Redis 不可用）时直接按数据库聚合计算，
 * 任何副本、任何时刻的读取口径都一致。
 */
export async function getCachedTotalStats(): Promise<StatsSnapshot> {
  const key = await totalStatsKey();
  const cached = await getFromRedis(key);
  if (cached) return cached;

  const { total: t, full_score: f } = await selectStatsRow();
  await setInRedis(key, { total: t, full_score: f });

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
  // 日期 + 全局 revision：跨日自动换键，策略切换也立即换键
  const redisKey =
    `${REDIS_STATS_TODAY_PREFIX}${today}:r${await currentGlobalRevision()}`;
  const cached = await getFromRedis(redisKey);
  if (cached) return cached;

  const { total: t, full_score: f } = await selectStatsRow(
    gte(submissions.created_at, today),
  );
  await setInRedis(redisKey, { total: t, full_score: f });

  return {
    total: t,
    full_score: f,
    not_full_score: t - f,
  };
}

/**
 * 新评测结果到达时失效缓存并推送 SSE 事件（支持多副本同步）。
 * 在 saveEvaluationResult 成功后调用。
 *
 * 计数完全由数据库聚合推导，这里只做缓存失效 + 通知，不维护进程内计数。
 */
export function applyNewResult(): void {
  // 失效"当日键"：当日键含 revision 与日期，revision 变化后自然换键；
  // 这里额外按前缀清理当日键，避免结果写入未递增全局 revision 时读到旧值。
  void clearTodayStatsKeys();
  // 写入 SSE 事件日志并发布 Redis 通知（fire-and-forget）
  void publishSseEvent(Channels.stats, { type: "stats:updated" });
}

/** 清理当日统计缓存键（含所有 revision 变体）。 */
async function clearTodayStatsKeys(): Promise<void> {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") return;
    const today = todayUtc();
    const pattern = `${REDIS_STATS_TODAY_PREFIX}${today}:r*`;
    // SCAN 而不是 KEYS：避免大 key 空间阻塞（多副本共享同一 Redis）
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    // ignore
  }
}

/**
 * 重置缓存（测试用）。
 *
 * 只清 Redis 键——不存在任何进程内状态可重置（多副本约束）。
 */
export function _resetStatsCacheForTest(): void {
  try {
    const redis = getRedis();
    if (redis.status === "ready") {
      const today = todayUtc();
      void redis.del(
        `${REDIS_STATS_TOTAL_PREFIX}0`,
        `${REDIS_STATS_TODAY_PREFIX}${today}:r0`,
      );
      void clearTodayStatsKeys();
      void clearTotalStatsKeys();
    }
  } catch {
    // ignore
  }
}

/** 清理全站统计缓存键（含所有 revision 变体）。 */
async function clearTotalStatsKeys(): Promise<void> {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") return;
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${REDIS_STATS_TOTAL_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
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
