import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { checkIns } from "../db/schema.ts";
import { ConflictError } from "../lib/errors.ts";

export interface CheckInResponse {
  checked_in: boolean;
  streak: number;
}

/**
 * 获取今日 UTC 日期字符串（YYYY-MM-DD）。
 * 所有签到相关日期统一使用 UTC，简化时区处理。
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 获取昨日 UTC 日期字符串。
 * 用 setUTCDate(-1) 而非 Date.now() - 86400000，正确处理日历日偏移
 * （评审 H3：跨 DST/夏令时/闰秒边界，固定 24h 偏移可能产生非预期日期）。
 */
function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
 * 获取今日签到状态。
 */
export async function getTodayCheckIn(
  userId: string,
): Promise<CheckInResponse> {
  const db = getDb();
  const today = todayUtc();

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

  return { checked_in: false, streak: 0 };
}
