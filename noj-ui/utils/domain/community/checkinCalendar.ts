/**
 * 个人主页签到日历渲染用的纯函数工具。
 */

export interface CalendarCell {
  date: string;
  day: number;
  checked: boolean;
  isToday: boolean;
}

/** 根据已签到日期集合生成当月 UTC 日历格子。 */
export function buildMonthCalendar(
  days: string[],
  today: string,
  referenceDate: Date = new Date(),
): CalendarCell[] {
  const month = referenceDate.toISOString().slice(0, 7);
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const checkedSet = new Set(days);
  const cells: CalendarCell[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    cells.push({
      date,
      day: d,
      checked: checkedSet.has(date),
      isToday: date === today,
    });
  }
  return cells;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 当前 UTC 月份 `YYYY-MM`（与后端签到活跃榜缺省月份口径一致）。 */
export function currentUtcMonth(referenceDate: Date = new Date()): string {
  return referenceDate.toISOString().slice(0, 7);
}

/** 校验 `YYYY-MM`，非法时回退到当前 UTC 月份（避免后端 400）。 */
export function normalizeMonth(month: unknown, referenceDate: Date = new Date()): string {
  return typeof month === 'string' && MONTH_RE.test(month) ? month : currentUtcMonth(referenceDate);
}

/** 月份平移：`shiftMonth('2026-01', -1) === '2025-12'`。 */
export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
