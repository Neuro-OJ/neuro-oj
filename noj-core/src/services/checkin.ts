import { and, eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { checkIns } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";

export interface CheckInResponse {
  checked_in: boolean;
  streak: number;
}

/**
 * 签到。
 * 每日仅限一次，返回当前连续签到天数。
 */
export async function checkIn(userId: string): Promise<CheckInResponse> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const existing = await db
    .select({ id: checkIns.id })
    .from(checkIns)
    .where(
      and(eq(checkIns.user_id, userId), eq(checkIns.checkin_date, today)),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new BadRequestError("今天已签到");
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const prev = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      and(eq(checkIns.user_id, userId), eq(checkIns.checkin_date, yesterday)),
    )
    .limit(1);

  const streak = (prev[0]?.streak ?? 0) + 1;
  const id = crypto.randomUUID();

  await db.insert(checkIns).values({
    id,
    user_id: userId,
    checkin_date: today,
    streak,
    created_at: new Date().toISOString(),
  });

  return { checked_in: true, streak };
}

/**
 * 获取今日签到状态。
 */
export async function getTodayCheckIn(
  userId: string,
): Promise<CheckInResponse> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const row = await db
    .select({ streak: checkIns.streak })
    .from(checkIns)
    .where(
      and(eq(checkIns.user_id, userId), eq(checkIns.checkin_date, today)),
    )
    .limit(1);

  if (row.length > 0) {
    return { checked_in: true, streak: row[0].streak };
  }

  return { checked_in: false, streak: 0 };
}
