/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { currentPageRemediation } from '../utils/education-remediation.ts';
import type { MatrixData, TeachingCell } from '../utils/education.ts';

Deno.test('补题快捷选择：只包括当前有效学生和确定未达标单元', () => {
  const cell = (
    item_id: string,
    status: TeachingCell['status'],
    updating = false,
  ) => ({ item_id, status, updating } as TeachingCell);
  const matrix = {
    rows: [
      { user_id: 'a', recipient_status: 'active', cells: [cell('p1', 'below_target'), cell('p2', 'achieved')] },
      { user_id: 'b', recipient_status: 'active', cells: [cell('p1', 'not_started'), cell('p3', 'judging')] },
      {
        user_id: 'c',
        recipient_status: 'active',
        cells: [cell('p4', 'unavailable'), cell('p5', 'below_target', true)],
      },
      { user_id: 'd', recipient_status: 'departed', cells: [cell('p6', 'below_target')] },
    ],
  } as MatrixData;
  assertEquals(currentPageRemediation(matrix), { studentIds: ['a', 'b'], itemIds: ['p1'] });
});
