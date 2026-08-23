/** utils/checkinCalendar.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { buildMonthCalendar } from '../utils/checkinCalendar.ts';

Deno.test('buildMonthCalendar: 生成当月日历并标记已签到日期', () => {
  const ref = new Date('2026-07-15T00:00:00Z');
  const cells = buildMonthCalendar(['2026-07-01', '2026-07-15'], '2026-07-15', ref);
  const first = cells[0]!;
  const mid = cells[14]!;
  const second = cells[1]!;
  assertEquals(cells.length, 31);
  assertEquals(first.date, '2026-07-01');
  assertEquals(first.checked, true);
  assertEquals(mid.date, '2026-07-15');
  assertEquals(mid.checked, true);
  assertEquals(mid.isToday, true);
  assertEquals(second.checked, false);
});

Deno.test('buildMonthCalendar: 空签到集合全部未选中', () => {
  const ref = new Date('2026-02-01T00:00:00Z');
  const cells = buildMonthCalendar([], '2026-02-10', ref);
  const tenth = cells[9]!;
  assertEquals(cells.length, 28);
  assertEquals(cells.every((c) => !c.checked), true);
  assertEquals(tenth.isToday, true);
});

Deno.test('buildMonthCalendar: 今日不在当月则不标记今日', () => {
  const ref = new Date('2026-03-01T00:00:00Z');
  const cells = buildMonthCalendar([], '2026-04-01', ref);
  assertEquals(cells.every((c) => !c.isToday), true);
});
