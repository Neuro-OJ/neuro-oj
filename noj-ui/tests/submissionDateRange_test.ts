/** utils/submissionDateRange.ts 单元测试（issue #581）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { buildDateRangeParams } from '../utils/submissionDateRange.ts';

const startOf = (d: string) => new Date(`${d}T00:00:00.000`).toISOString();
const endOf = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

Deno.test('buildDateRangeParams: 未填写时不产生参数', () => {
  assertEquals(buildDateRangeParams('', ''), {});
});

Deno.test('buildDateRangeParams: 起止日期换算为本地整天对应的 UTC ISO', () => {
  assertEquals(buildDateRangeParams('2026-10-01', '2026-10-03'), {
    from: startOf('2026-10-01'),
    to: endOf('2026-10-03'),
  });
});

Deno.test('buildDateRangeParams: 只填一端时仅输出该端', () => {
  assertEquals(buildDateRangeParams('2026-10-01', ''), { from: startOf('2026-10-01') });
  assertEquals(buildDateRangeParams('', '2026-10-01'), { to: endOf('2026-10-01') });
});

Deno.test('buildDateRangeParams: 同一天覆盖整天', () => {
  const { from, to } = buildDateRangeParams('2026-10-01', '2026-10-01');
  assertEquals(new Date(to!).getTime() - new Date(from!).getTime(), 86_400_000 - 1);
});

Deno.test('buildDateRangeParams: 起止颠倒时自动交换', () => {
  assertEquals(buildDateRangeParams('2026-10-05', '2026-10-01'), {
    from: startOf('2026-10-01'),
    to: endOf('2026-10-05'),
  });
});

Deno.test('buildDateRangeParams: 非法格式被忽略', () => {
  assertEquals(buildDateRangeParams('2026/10/01', 'abc'), {});
});
