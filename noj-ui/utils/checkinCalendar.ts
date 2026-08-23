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
