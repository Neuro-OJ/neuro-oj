import type { MatrixData } from './education.ts';

/** 仅从已授权且更新完成的当前页选择，不把等待评测或资源失效当作未达标。 */
export function currentPageRemediation(matrix: MatrixData) {
  const students = new Set<string>(), items = new Set<string>();
  for (const row of matrix.rows) {
    if (row.recipient_status !== 'active') continue;
    for (const cell of row.cells) {
      if (cell.updating || !['not_started', 'below_target'].includes(cell.status)) continue;
      students.add(row.user_id);
      items.add(cell.item_id);
    }
  }
  return { studentIds: [...students], itemIds: [...items] };
}
