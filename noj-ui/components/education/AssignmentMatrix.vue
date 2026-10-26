<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MatrixData, TeachingCell } from '~/utils/education';
import { teachingCellLabel } from '~/utils/education';
const props = defineProps<{ matrix: MatrixData; titles?: Record<string, string> }>();
const emit = defineEmits<{ select: [userId: string, cell: TeachingCell] }>();
const expanded = ref<string | null>(null);
const focused = ref<{ row: number; col: number }>({ row: 0, col: 0 });

// 分别比较结构键，成绩轮询返回新对象时保留展开和键盘位置。
watch([() => props.matrix.page, () => props.matrix.scope, () => props.matrix.rows.map(row => row.user_id).join(','), () => props.matrix.items.map(item => item.id).join(',')], () => {
  expanded.value = null;
  focused.value = { row: 0, col: 0 };
});

const rows = computed(() => props.matrix.rows);
const items = computed(() => props.matrix.items);

function itemTitle(itemId: string) {
  const item = items.value.find(value => value.id === itemId);
  return item ? props.titles?.[item.reference.qualified_ref] ?? `题目 ${item.reference.display_ref}` : '题目';
}
function requirementLabel(item: { requirement: 'accepted' | 'min_score'; minimum_score: number | null }) {
  return item.requirement === 'accepted' ? '正式通过' : `至少 ${(item.minimum_score ?? 0) / 100} 分`;
}
function achievedInColumn(itemId: string) {
  return rows.value.filter(row => row.cells.some(cell => cell.item_id === itemId && !cell.updating && cell.status === 'achieved')).length;
}
function rowAchieved(cells: TeachingCell[]) {
  return cells.filter(cell => !cell.updating && cell.status === 'achieved').length;
}
function rowSummary(cells: TeachingCell[]) {
  if (props.matrix.updating || cells.some(cell => cell.updating)) return '成绩更新中';
  return `已达标 ${rowAchieved(cells)} / ${cells.length}`;
}
interface CellView { icon: string; spin: boolean; text: string; cls: string; aria: string; dot?: boolean }
function cellView(cell: TeachingCell | undefined): CellView | null {
  if (!cell) return null;
  if (cell.updating) return { icon: 'i-lucide-loader-circle', spin: true, text: '', cls: 'text-text-muted', aria: '更新中' };
  const score = cell.score === null ? '' : String(cell.score / 100);
  if (cell.status === 'achieved') return { icon: 'i-lucide-check', spin: false, text: score, cls: 'text-signal-deep', aria: teachingCellLabel(cell) };
  if (cell.status === 'below_target') return { icon: '', spin: false, dot: true, text: score || '未达标', cls: 'text-text', aria: teachingCellLabel(cell) };
  if (cell.status === 'judging') return { icon: 'i-lucide-loader-circle', spin: true, text: '评测中', cls: 'text-primary-dark', aria: teachingCellLabel(cell) };
  if (cell.status === 'unavailable') return { icon: 'i-lucide-circle-slash', spin: false, text: '', cls: 'text-text-muted', aria: '资源不可用' };
  return { icon: '', spin: false, text: '—', cls: 'text-text-muted', aria: '未开始' };
}
function cellAt(row: MatrixData['rows'][number], itemId: string) {
  return row.cells.find(cell => cell.item_id === itemId);
}
function select(userId: string, cell: TeachingCell | undefined) {
  if (cell) emit('select', userId, cell);
}
function cellTabIndex(rowIndex: number, colIndex: number) {
  return focused.value.row === rowIndex && focused.value.col === colIndex ? 0 : -1;
}
function onCellFocus(rowIndex: number, colIndex: number) {
  focused.value = { row: rowIndex, col: colIndex };
}
/** 表格内方向键漫游：40 名学生 × 10 道题时不必逐格 Tab。 */
function onCellKeydown(event: KeyboardEvent, rowIndex: number, colIndex: number) {
  const deltas: Record<string, [number, number]> = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };
  const delta = deltas[event.key];
  if (!delta) return;
  const rowCount = rows.value.length, columnCount = items.value.length;
  if (!rowCount || !columnCount) return;
  const nextRow = Math.min(Math.max(rowIndex + delta[0], 0), rowCount - 1);
  const nextColumn = Math.min(Math.max(colIndex + delta[1], 0), columnCount - 1);
  if (nextRow === rowIndex && nextColumn === colIndex) return;
  event.preventDefault();
  const table = (event.currentTarget as HTMLElement).closest('table');
  const target = table?.querySelector<HTMLButtonElement>(`button[data-row="${nextRow}"][data-col="${nextColumn}"]`);
  if (!target) return;
  focused.value = { row: nextRow, col: nextColumn };
  target.focus();
}
</script>
<template>
  <div>
    <div v-if="matrix.updating" role="status"
      class="mx-4 my-3 flex items-center gap-2 rounded border border-primary/25 bg-primary-bg px-3 py-2 text-sm text-primary-text sm:mx-5">
      <UIcon name="i-lucide-refresh-cw" class="size-4 animate-spin-slow" />
      成绩正在更新，旧成绩暂不展示
    </div>
    <div class="hidden overflow-x-auto sm:block">
      <table class="w-full text-sm" aria-label="学生成绩矩阵" :aria-busy="matrix.updating">
        <thead class="border-b border-border bg-bg-sunken text-left">
          <tr>
            <th scope="col" class="sticky left-0 z-20 min-w-44 bg-bg-sunken px-4 py-3 font-medium">学生</th>
            <th v-for="item in matrix.items" :key="item.id"
              class="min-w-40 border-l border-border/70 px-3 py-3 align-top font-medium">
              <span class="font-mono text-xs text-text-secondary">{{ item.reference.display_ref }}</span>
              <p class="mt-0.5 line-clamp-2 whitespace-normal text-sm font-medium leading-snug">
                {{ titles?.[item.reference.qualified_ref] ?? `题目 ${item.reference.display_ref}` }}
              </p>
              <p class="mt-1 text-11px font-normal text-text-secondary">
                {{ requirementLabel(item) }}
                · <span class="tabular-nums">{{ achievedInColumn(item.id) }}/{{ matrix.rows.length }} 达标</span>
              </p>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in matrix.rows" :key="row.user_id"
            class="group border-b border-border last:border-0 hover:bg-primary-bg/60">
            <th scope="row"
              class="sticky left-0 z-10 min-w-44 bg-bg-panel px-4 py-2 text-left font-normal group-hover:bg-primary-bg/60">
              <span class="block break-words font-medium">{{ row.username }}</span>
              <span class="mt-0.5 block text-11px text-text-muted tabular-nums">
                {{ rowSummary(row.cells) }}<template v-if="row.recipient_status !== 'active'"> · 历史学生</template>
              </span>
            </th>
            <td v-for="(item, colIndex) in matrix.items" :key="item.id" class="border-l border-border/70 p-1.5">
              <button v-if="cellAt(row, item.id)" type="button" :data-row="rowIndex" :data-col="colIndex"
                :tabindex="cellTabIndex(rowIndex, colIndex)"
                :aria-label="`${row.username} ${item.reference.display_ref} ${cellView(cellAt(row, item.id))?.aria ?? ''}`"
                title="查看提交与反馈"
                class="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-bg-sunken"
                :class="cellView(cellAt(row, item.id))?.cls" @focus="onCellFocus(rowIndex, colIndex)"
                @keydown="onCellKeydown($event, rowIndex, colIndex)" @click="select(row.user_id, cellAt(row, item.id))">
                <UIcon v-if="cellView(cellAt(row, item.id))?.spin" name="i-lucide-loader-circle"
                  class="size-4 shrink-0 animate-spin-slow" aria-hidden="true" />
                <UIcon v-else-if="cellView(cellAt(row, item.id))?.icon" :name="cellView(cellAt(row, item.id))!.icon"
                  class="size-4 shrink-0" aria-hidden="true" />
                <span v-else-if="cellView(cellAt(row, item.id))?.dot" class="size-1.5 shrink-0 rounded-full bg-warning-text"
                  aria-hidden="true" />
                <span v-if="cellView(cellAt(row, item.id))?.text" class="tabular-nums">{{ cellView(cellAt(row, item.id))!.text }}</span>
                <span v-if="cellView(cellAt(row, item.id))?.aria === '更新中'" class="sr-only">更新中</span>
                <span v-if="cellAt(row, item.id)?.late" class="text-11px font-normal text-text-secondary">逾期</span>
              </button>
              <span v-else class="flex min-h-9 items-center justify-center text-text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ul class="divide-y divide-border sm:hidden" aria-label="学生成绩摘要">
      <li v-for="row in matrix.rows" :key="row.user_id">
        <button type="button"
          class="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-primary-bg/60"
          :aria-expanded="expanded === row.user_id" :aria-controls="`student-results-${row.user_id}`"
          @click="expanded = expanded === row.user_id ? null : row.user_id">
          <span class="min-w-0">
            <span class="block break-words font-medium">{{ row.username }}</span>
            <span class="mt-0.5 block text-sm text-text-secondary tabular-nums">
              {{ rowSummary(row.cells) }}<template v-if="row.recipient_status !== 'active'"> · 历史学生</template>
            </span>
          </span>
          <UIcon :name="expanded === row.user_id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="size-4 shrink-0 text-text-secondary" />
        </button>
        <div :id="`student-results-${row.user_id}`" v-show="expanded === row.user_id"
          class="border-t border-border bg-bg-sunken/40 px-4">
          <button v-for="cell in row.cells" :key="cell.item_id" type="button"
            class="flex w-full items-center justify-between gap-3 border-b border-border py-3 text-left transition-colors last:border-0 hover:bg-bg-panel/70"
            :aria-label="`${row.username} ${matrix.items.find(item => item.id === cell.item_id)?.reference.display_ref} ${cellView(cell)?.aria ?? ''}`"
            @click="select(row.user_id, cell)">
            <span class="min-w-0 text-sm">
              <span class="block break-words">{{ itemTitle(cell.item_id) }}</span>
              <span class="mt-0.5 block text-11px text-text-muted">
                {{ matrix.items.find(item => item.id === cell.item_id)?.reference.display_ref }}
                · {{ matrix.items.find(item => item.id === cell.item_id) ? requirementLabel(matrix.items.find(item => item.id === cell.item_id)!) : '' }}
              </span>
            </span>
            <span class="inline-flex shrink-0 items-center gap-1.5 text-sm" :class="cellView(cell)?.cls">
              <UIcon v-if="cellView(cell)?.spin" name="i-lucide-loader-circle"
                class="size-4 animate-spin-slow" aria-hidden="true" />
              <UIcon v-else-if="cellView(cell)?.icon" :name="cellView(cell)!.icon" class="size-4" aria-hidden="true" />
              <span v-else-if="cellView(cell)?.dot" class="size-1.5 rounded-full bg-warning-text" aria-hidden="true" />
              <span class="tabular-nums">{{ teachingCellLabel(cell) }}</span>
            </span>
            <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>

    <p v-if="!matrix.rows.length" class="px-4 py-10 text-center text-sm text-text-muted">没有符合筛选条件的学生</p>
    <div v-else class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-11px text-text-muted sm:px-5">
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="inline-flex items-center gap-1"><UIcon name="i-lucide-check" class="size-3 text-signal-deep" />达标</span>
        <span class="inline-flex items-center gap-1"><span class="size-1.5 rounded-full bg-warning-text" aria-hidden="true" />未达标</span>
        <span>— 未开始</span>
        <span class="inline-flex items-center gap-1"><UIcon name="i-lucide-circle-slash" class="size-3" />资源不可用</span>
      </p>
      <p>
        <span class="sm:hidden">点击学生展开，再点题目查看提交</span>
        <span class="hidden sm:inline">点击单元格查看提交与反馈</span>
      </p>
    </div>
  </div>
</template>
