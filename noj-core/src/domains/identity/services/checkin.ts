import { eq, sql } from "drizzle-orm";
import { todayUtc } from "./../../../shared/base/dates.ts";
import { getDb } from "../../../db/connection.ts";
import { checkIns, users } from "../../../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";

/** 签到操作/今日状态的响应。 */
export interface CheckInResponse {
  checked_in: boolean;
  streak: number;
}

/** 签到统计结果。 */
export interface CheckinStats {
  /** 累计签到天数 */
  total_days: number;
  /** 当前连续天数（今日未签到时为昨日 streak，未连续则为 0） */
  current_streak: number;
  /** 历史最长连续天数 */
  max_streak: number;
  /** 指定月份（默认当月，UTC）签到天数 */
  month_days: number;
  /** 最近签到日期（YYYY-MM-DD），从未签到为 null */
  last_checkin_date: string | null;
}

/** 签到历史结果。 */
export interface CheckinHistory {
  /** 最近 N 天内已签到的日期（升序，含今日） */
  days: string[];
  total_days: number;
}

/** 签到活跃榜单行数据。 */
export interface CheckinLeaderboardRow {
  rank: number;
  user_id: string;
  username: string;
  /** 当月签到天数 */
  days: number;
}

/** 签到活跃榜响应。 */
export interface CheckinLeaderboard {
  data: CheckinLeaderboardRow[];
  total: number;
  /** 当前用户当月排名（未上榜 / 未登录为 null） */
  user_rank: number | null;
}

/** 历史查询允许的 days 取值（issue #184） */
const HISTORY_DAYS_ALLOWED = new Set([30, 90, 365]);

/**
 * 月份参数规范化：缺省取当前 UTC 月（YYYY-MM），非法格式抛 400。
 */
function normalizeMonth(month: string | undefined): string {
  if (month === undefined || month === "") {
    return new Date().toISOString().slice(0, 7);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new BadRequestError("month 参数格式应为 YYYY-MM");
  }
  return month;
}

/**
 * 校验目标用户存在（stats/history 支持按 user_id 查询他人）。
 */
async function assertUserExists(userId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    throw new NotFoundError("用户不存在");
  }
}

/**
 * 获取今日 UTC 日期字符串（YYYY-MM-DD）。
 * 所有签到相关日期统一使用 UTC，简化时区处理。
 */
/**
 * 获取昨日 UTC 日期字符串。
 * 用 setUTCDate(-1) 而非 Date.now() - 86400000，正确处理日历日偏移
 * （评审 H3：跨 DST/夏令时/闰秒边界，固定 24h 偏移可能产生非预期日期）。
 */
function yesterdayUtc(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * 签到。
 * 每日仅限一次，返回当前连续签到天数。
 *
 * 并发安全（评审 H2）：
 * 用 INSERT ... ON CONFLICT DO NOTHING RETURNING 替代 SELECT-then-INSERT，
 * 避免两个并发请求都通过 SELECT 检查后同时 INSERT 导致 UNIQUE 约束冲突
 * 返回 500。ON CONFLICT DO NOTHING 让两个并发请求之一返回 affectedRows=0，
 * 由调用方据此抛 ConflictError。
 *
 * 错误分类（评审 M6）：
 * PG 23505（UNIQUE 冲突）已在 SQL 层 ON CONFLICT 处理；FK 违反（23503）
 * 视为数据异常转 500；网络中断由 Drizzle 抛出原始错误，由全局 onError 处理。
 */
export async function checkIn(userId: string): Promise<CheckInResponse> {
  const db = getDb();
  const today = todayUtc();
  const yesterday = yesterdayUtc();

  // 先查昨日 streak（O(1) 索引查询）
  const prevRows = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} = ${yesterday}`,
    )
    .limit(1);
  const prevStreak = prevRows[0]?.streak ?? 0;
  const newStreak = prevStreak + 1;

  // 原子插入：ON CONFLICT DO NOTHING + RETURNING 处理并发竞态
  const inserted = await db
    .insert(checkIns)
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      checkin_date: today,
      streak: newStreak,
      created_at: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [checkIns.user_id, checkIns.checkin_date],
    })
    .returning({ id: checkIns.id });

  if (inserted.length === 0) {
    // 并发请求之一抢到了，另一个因 UNIQUE 冲突未插入
    throw new ConflictError("今天已签到");
  }

  return { checked_in: true, streak: newStreak };
}

/**
 * 获取今日签到状态（issue #184）。
 *
 * 今日未签到时返回进行中的连续天数（昨日 streak，昨日未签到则为 0），
 * 使首页签到卡始终可见连续天数。
 */
export async function getTodayCheckIn(
  userId: string,
): Promise<CheckInResponse> {
  const db = getDb();
  const today = todayUtc();
  const yesterday = yesterdayUtc();

  const row = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} = ${today}`,
    )
    .limit(1);

  if (row.length > 0) {
    return { checked_in: true, streak: row[0].streak };
  }

  const prevRow = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} = ${yesterday}`,
    )
    .limit(1);

  return { checked_in: false, streak: prevRow[0]?.streak ?? 0 };
}

/**
 * 签到统计（issue #184）。
 *
 * - `current_streak`：今日已签到 → 今日 streak；未签到 → 昨日 streak（昨日未签到为 0）
 * - `month_days`：默认当月（UTC），支持 `month=YYYY-MM` 查询参数
 */
export async function getCheckinStats(
  userId: string,
  month?: string,
): Promise<CheckinStats> {
  await assertUserExists(userId);
  const db = getDb();
  const monthPrefix = normalizeMonth(month);

  const [[totalRow], [maxRow], [lastRow], [monthRow]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(checkIns)
      .where(eq(checkIns.user_id, userId)),
    db
      .select({ max: sql<number | null>`max(${checkIns.streak})` })
      .from(checkIns)
      .where(eq(checkIns.user_id, userId)),
    db
      .select({ last: sql<string | null>`max(${checkIns.checkin_date})` })
      .from(checkIns)
      .where(eq(checkIns.user_id, userId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(checkIns)
      .where(
        sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} LIKE ${
          monthPrefix + "%"
        }`,
      ),
  ]);

  const today = todayUtc();
  const yesterday = yesterdayUtc();
  const todayRow = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} = ${today}`,
    )
    .limit(1);
  let currentStreak = todayRow[0]?.streak ?? 0;
  if (!todayRow[0]) {
    const prevRow = await db
      .select({ streak: checkIns.streak })
      .from(checkIns)
      .where(
        sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} = ${yesterday}`,
      )
      .limit(1);
    currentStreak = prevRow[0]?.streak ?? 0;
  }

  return {
    total_days: Number(totalRow?.count ?? 0),
    current_streak: currentStreak,
    max_streak: Number(maxRow?.max ?? 0),
    month_days: Number(monthRow?.count ?? 0),
    last_checkin_date: lastRow?.last ?? null,
  };
}

/**
 * 签到历史（issue #184）：最近 N 天（含今日）内已签到的日期升序数组。
 * `days` 仅允许 30 / 90 / 365。
 */
export async function getCheckinHistory(
  userId: string,
  days: number,
): Promise<CheckinHistory> {
  await assertUserExists(userId);
  if (!HISTORY_DAYS_ALLOWED.has(days)) {
    throw new BadRequestError("days 参数仅支持 30/90/365");
  }
  const db = getDb();
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  const start = startDate.toISOString().slice(0, 10);

  const rows = await db
    .select({ date: checkIns.checkin_date })
    .from(checkIns)
    .where(
      sql`${checkIns.user_id} = ${userId} AND ${checkIns.checkin_date} >= ${start}`,
    )
    .orderBy(sql`${checkIns.checkin_date} ASC`);

  return { days: rows.map((r) => r.date), total_days: rows.length };
}

/**
 * 签到活跃榜（issue #184）。
 *
 * 按指定月份（缺省当月，UTC）签到天数倒序 + 用户名升序排名，
 * rank 由 ROW_NUMBER() 计算，保证跨分页一致性；登录时额外返回 user_rank。
 */
export async function getCheckinLeaderboard(
  month: string | undefined,
  page: number,
  perPage: number,
  userId?: string,
): Promise<CheckinLeaderboard> {
  const db = getDb();
  const monthPrefix = normalizeMonth(month);
  const offset = (page - 1) * perPage;

  const ranked = sql`
    SELECT user_id, username, days, rank FROM (
      SELECT c.user_id AS user_id, u.username AS username, COUNT(*) AS days,
             ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, u.username ASC) AS rank
      FROM ${checkIns} c
      JOIN ${users} u ON u.id = c.user_id
      WHERE c.checkin_date LIKE ${monthPrefix + "%"}
      GROUP BY c.user_id, u.username
    ) t
  `;

  const rows = await db.execute(
    sql`${ranked} ORDER BY rank LIMIT ${perPage} OFFSET ${offset}`,
  );
  const data = unwrapRows<Record<string, unknown>>(rows as never).map((
    row,
  ) => ({
    rank: Number(row.rank),
    user_id: row.user_id as string,
    username: row.username as string,
    days: Number(row.days),
  }));

  const totalRows = await db.execute(
    sql`SELECT COUNT(*) AS total FROM (
      SELECT user_id FROM ${checkIns} WHERE checkin_date LIKE ${
      monthPrefix + "%"
    } GROUP BY user_id
    ) t`,
  );
  const totalRow = unwrapRows<Record<string, unknown>>(totalRows as never)[0];
  const total = Number(totalRow?.total ?? 0);

  let userRank: number | null = null;
  if (userId) {
    const rankRows = await db.execute(
      sql`${ranked} WHERE user_id = ${userId}`,
    );
    const rankRow = unwrapRows<Record<string, unknown>>(rankRows as never)[0];
    userRank = rankRow ? Number(rankRow.rank) : null;
  }

  return { data, total, user_rank: userRank };
}
