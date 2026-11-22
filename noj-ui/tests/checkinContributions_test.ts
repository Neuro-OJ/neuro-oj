/** utils/checkinContributions.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { buildContributionGrid, formatDateFull } from '../utils/checkinContributions.ts';

Deno.test('buildContributionGrid: 网格从最早签到日所在周日起，到当前周为止', () => {
  // 2026-08-20 是周四，最早签到日所在周起点应为 2026-08-16（周日）
  const grid = buildContributionGrid(
    ['2026-08-20'],
    '2026-08-20',
    '2026-08-23', // 周日（本周）
  );
  assertEquals(grid.weeks.length, 2); // 08-16 那周 + 本周
  assertEquals(grid.weeks[0]!.startDate, '2026-08-16');
  assertEquals(grid.weeks[1]!.startDate, '2026-08-23');
  // 每周固定 7 行（周日…周六）
  assertEquals(grid.weeks[0]!.cells.length, 7);
  assertEquals(grid.weeks[0]!.cells[0]!.rowIndex, 0); // 周日
  assertEquals(grid.weeks[0]!.cells[6]!.rowIndex, 6); // 周六
});

Deno.test('buildContributionGrid: 标记已签到格子与今日', () => {
  const grid = buildContributionGrid(
    ['2026-08-20', '2026-08-21'],
    '2026-08-20',
    '2026-08-30',
  );
  // 08-16(周日)那周：08-20 周四、08-21 周五
  const thursday = grid.weeks[0]!.cells[4]!;
  assertEquals(thursday.date, '2026-08-20');
  assertEquals(thursday.checked, true);
  const friday = grid.weeks[0]!.cells[5]!;
  assertEquals(friday.checked, true);
  const monday = grid.weeks[0]!.cells[1]!;
  assertEquals(monday.checked, false);
  // 今日 08-30（周日）是第三周起点
  const today = grid.weeks[2]!.cells[0]!;
  assertEquals(today.date, '2026-08-30');
  assertEquals(today.isToday, true);
});

Deno.test('buildContributionGrid: 月轴按跨月标记', () => {
  // 07-30(周四) 起始周 07-26；覆盖 07、08 月
  const grid = buildContributionGrid(
    [],
    '2026-07-30',
    '2026-08-10',
  );
  const monthLabels = grid.weeks.map((w) => w.monthLabel);
  // 周起：07-26(7月)、08-02(8月)、08-09(8月)
  assertEquals(monthLabels[0], '2026-07');
  assertEquals(monthLabels[1], '2026-08');
  assertEquals(monthLabels[2], null); // 与上一周同月
});

Deno.test('formatDateFull: 输出中文完整日期与星期', () => {
  assertEquals(formatDateFull('2026-08-20'), '2026年8月20日 星期四');
  assertEquals(formatDateFull('2026-08-23'), '2026年8月23日 星期日');
  assertEquals(formatDateFull('2026-01-01'), '2026年1月1日 星期四');
});

Deno.test('buildContributionGrid: 未来日期不渲染方块（格子为 null）', () => {
  // 08-24(周一) 是未来日期
  const grid = buildContributionGrid(
    [],
    '2026-08-20',
    '2026-08-23',
  );
  // 08-16 那周全是今天之前（今日 08-23 周日），未来格子在本周之后
  const future = grid.weeks[0]!.cells[0]!;
  assertEquals(future.date, '2026-08-16');
  // 本周 08-23 周日为今天；无未来格子因为到 08-23 为止
  const lastWeek = grid.weeks[1]!;
  const lastCell = lastWeek.cells[0]!;
  assertEquals(lastCell.date, '2026-08-23');
  assertEquals(lastCell.isToday, true);
});

Deno.test('buildContributionGrid: 未来超过今天的格子置空', () => {
  // today=2026-08-20（周四），本周 08-16~08-22，其中 21/22 未来
  const grid = buildContributionGrid(
    [],
    '2026-08-20',
    '2026-08-20',
  );
  const week = grid.weeks[0]!;
  // 周日08-16~周四08-20 有方块，周五08-21/周六08-22 为 null
  assertEquals(week.cells[0]!.date, '2026-08-16');
  assertEquals(week.cells[4]!.date, '2026-08-20');
  assertEquals(week.cells[4]!.isToday, true);
  assertEquals(week.cells[5], null);
  assertEquals(week.cells[6], null);
});

Deno.test('buildContributionGrid: 年份轴按跨年标记', () => {
  // 2025-12-30(周二) 起始周 2025-12-28；本周 2026-01-04 起
  const grid = buildContributionGrid(
    [],
    '2025-12-30',
    '2026-01-05',
  );
  const yearLabels = grid.weeks.map((w) => w.yearLabel);
  assertEquals(grid.weeks.length, 2);
  assertEquals(yearLabels[0], '2025');
  assertEquals(yearLabels[1], '2026');
});
