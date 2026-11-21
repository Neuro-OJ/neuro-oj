/**
 * GitHub 风格签到贡献图（issue：用户主页活跃度）。
 *
 * 网格模型（对齐 GitHub contribution graph）：
 * - 每一行是一个星期几，共 7 行，固定首行周日、末行周六
 * - 每一列是一周（含该周 7 天）
 * - 列从左到右：起始展示日所在周 → 当前周（含未签到的今天/未来格子）
 * - 左右显示月轴（每列开头所在月份）
 * - 每列固定 7 行（周日…周六）
 * - 界面过长时外层横向滚动
 *
 * 数据来源：后端 getCheckinHistory 返回的已签到日期数组（YYYY-MM-DD）。
 */

export interface ContributionCell {
  /** 该格子的完整日期 YYYY-MM-DD（空则无） */
  date: string;
  /** 是否已签到 */
  checked: boolean;
  /** 是否为今天 */
  isToday: boolean;
  /** 该格子属于的第几列（周） */
  weekIndex: number;
  /** 该格子所在行（0=周日 … 6=周六） */
  rowIndex: number;
}

export interface ContributionWeek {
  /** 该列对应日期范围，用于月轴/ tooltip 边界 */
  startDate: string;
  endDate: string;
  /** 该列起始的月份（YYYY-MM），月轴用；与上一列同月则为 null */
  monthLabel: string | null;
  /** 该列起始的年（YYYY），月轴第一行用；与上一列同年则为 null */
  yearLabel: string | null;
  cells: (ContributionCell | null)[];
}

export interface ContributionGrid {
  weeks: ContributionWeek[];
  /** 今天日期 YYYY-MM-DD */
  today: string;
}

/** 星期名（首行周日） */
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 格式化完整日期：YYYY-MM-DD → "2026年8月26日 星期三" */
export function formatDateFull(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 星期${weekdays[d.getUTCDay()]}`;
}

/** UTC 加天数 */
function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 当天是星期几（0=周日） */
function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/**
 * 生成贡献图网格。
 *
 * @param checkedDays 已签到日期集合（YYYY-MM-DD）
 * @param startDate   起始展示日（通常为一年前；组件会对齐到所在周起点）
 * @param today       今天日期 YYYY-MM-DD
 */
export function buildContributionGrid(
  checkedDays: string[],
  startDate: string,
  today: string,
): ContributionGrid {
  const checked = new Set(checkedDays);

  // 对齐起点到所在周的周日
  const startDow = dayOfWeek(startDate);
  const weekStart = startDow === 0 ? startDate : addDays(startDate, -startDow);

  // 终点为本周（含今天）
  const todayDow = dayOfWeek(today);
  const todayWeekStart = todayDow === 0 ? today : addDays(today, -todayDow);

  const weeks: ContributionWeek[] = [];
  let cursor = weekStart;
  let weekIndex = 0;
  let lastMonth = '';
  let lastYear = '';
  while (cursor <= todayWeekStart) {
    const cells: (ContributionCell | null)[] = [];
    const cellDate: string[] = [];
    for (let row = 0; row < 7; row++) {
      const d = addDays(cursor, row);
      cellDate.push(d);
      // 未来日期（晚于今天）不渲染方块
      if (d > today) {
        cells.push(null);
        continue;
      }
      cells.push({
        date: d,
        checked: checked.has(d),
        isToday: d === today,
        weekIndex,
        rowIndex: row,
      });
    }
    const weekStartDate = cellDate[0]!;
    const weekEndDate = cellDate[6]!;
    const monthOfStart = weekStartDate.slice(0, 7);
    const yearOfStart = weekStartDate.slice(0, 4);
    weeks.push({
      startDate: weekStartDate,
      endDate: weekEndDate,
      monthLabel: monthOfStart === lastMonth ? null : monthOfStart,
      yearLabel: yearOfStart === lastYear ? null : yearOfStart,
      cells,
    });
    lastMonth = monthOfStart;
    lastYear = yearOfStart;
    weekIndex++;
    cursor = addDays(cursor, 7);
  }
  return { weeks, today };
}
