<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MatrixData, TeachingCell } from '~/utils/education';
import { teachingCellLabel } from '~/utils/education';
const props = defineProps<{ matrix: MatrixData; titles?: Record<string, string> }>();
const expanded = ref<string | null>(null);
watch(() => [props.matrix.page, props.matrix.scope, props.matrix.rows.map(row => row.user_id).join(',')], () => { expanded.value = null; });
function rowSummary(cells: TeachingCell[]) {
  if (props.matrix.updating || cells.some(cell => cell.updating)) return '成绩更新中';
  const achieved = cells.filter(cell => cell.status === 'achieved').length;
  const unavailable = cells.filter(cell => cell.status === 'unavailable').length;
  return `已达标 ${achieved} / ${cells.length}${unavailable ? ` · ${unavailable} 题资源不可用` : ''}`;
}
const emit = defineEmits<{ select: [userId: string, cell: TeachingCell] }>();
</script>
<template>
  <div>
    <UAlert v-if="matrix.updating" class="mb-3" color="info" title="成绩正在更新，旧成绩暂不展示"
      icon="i-lucide-refresh-cw" />
    <div class="hidden overflow-x-auto rounded border border-border sm:block">
      <table class="w-full text-sm" aria-label="学生成绩矩阵">
        <thead class="bg-bg-sunken text-left">
          <tr>
            <th class="sticky left-0 z-10 bg-bg-sunken p-3">学生</th>
            <th v-for="item in matrix.items" :key="item.id" class="min-w-36 p-3 font-medium">
              <span>{{ item.reference.display_ref }}</span><p v-if="titles?.[item.reference.qualified_ref]" class="mt-1 max-w-52 whitespace-normal text-xs text-text-secondary">{{ titles[item.reference.qualified_ref] }}</p>
              <p
                class="mt-1 text-xs font-normal text-text-muted">{{ item.requirement === 'accepted' ? '正式通过' : `至少 ${(item.minimum_score ?? 0) / 100} 分` }}</p>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in matrix.rows" :key="row.user_id" class="border-t border-border">
            <th
              class="sticky left-0 z-10 bg-bg-panel p-3 text-left font-medium">{{ row.username }}<span v-if="row.recipient_status !== 'active'" class="block text-xs text-text-muted">历史学生</span></th>
            <td v-for="cell in row.cells" :key="cell.item_id" class="p-2 tabular-nums">
              <UButton variant="ghost" :color="!cell.updating && cell.status === 'achieved' ? 'success' : 'neutral'"
                :aria-label="`${row.username} ${matrix.items.find(i => i.id === cell.item_id)?.reference.display_ref} ${teachingCellLabel(cell)}`"
                @click="emit('select', row.user_id, cell)">{{ teachingCellLabel(cell) }}</UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ul class="divide-y divide-border overflow-hidden rounded border border-border bg-bg-panel sm:hidden" aria-label="学生成绩摘要">
      <li v-for="row in matrix.rows" :key="row.user_id">
        <button type="button" class="flex min-h-16 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-primary-hover-bg" :aria-expanded="expanded === row.user_id" :aria-controls="`student-results-${row.user_id}`" @click="expanded = expanded === row.user_id ? null : row.user_id">
          <span class="min-w-0"><span class="block break-words font-medium">{{ row.username }}</span><span class="mt-1 block text-sm text-text-secondary tabular-nums">{{ rowSummary(row.cells) }}</span><span v-if="row.recipient_status !== 'active'" class="text-xs text-text-muted">历史学生</span></span>
          <UIcon :name="expanded === row.user_id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 shrink-0 text-text-secondary" />
        </button>
        <div :id="`student-results-${row.user_id}`" v-show="expanded === row.user_id" class="border-t border-border bg-bg-sunken/40 px-4">
          <div v-for="cell in row.cells" :key="cell.item_id" class="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
            <div class="min-w-0 text-sm"><p class="break-words">{{ titles?.[matrix.items.find(item => item.id === cell.item_id)?.reference.qualified_ref ?? ''] ?? matrix.items.find(item => item.id === cell.item_id)?.reference.display_ref }}</p><p class="mt-1 text-xs text-text-secondary">{{ matrix.items.find(item => item.id === cell.item_id)?.reference.display_ref }}</p></div>
            <UButton variant="ghost" class="min-h-11 shrink-0" :aria-label="`${row.username} ${matrix.items.find(item => item.id === cell.item_id)?.reference.display_ref} ${teachingCellLabel(cell)}`" @click="emit('select', row.user_id, cell)">{{ teachingCellLabel(cell) }}</UButton>
          </div>
        </div>
      </li>
    </ul>
    <p v-if="!matrix.rows.length" class="py-8 text-center text-text-muted">没有符合筛选条件的学生</p>
  </div>
</template>
