<script setup lang="ts">
import type { MatrixData, TeachingCell } from '~/utils/education';
import { teachingCellLabel } from '~/utils/education';
defineProps<{ matrix: MatrixData }>();
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
              <span>{{ item.reference.display_ref }}</span>
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
    <div class="space-y-3 sm:hidden">
      <UCard v-for="row in matrix.rows" :key="row.user_id">
        <h3 class="mb-3 font-medium">{{ row.username }}</h3>
        <div v-for="cell in row.cells" :key="cell.item_id"
          class="flex items-center justify-between gap-2 border-t border-border py-2">
          <span>{{ matrix.items.find((i) => i.id === cell.item_id)?.reference.display_ref }}</span>
          <UButton size="sm" variant="ghost"
            @click="emit('select', row.user_id, cell)">{{ teachingCellLabel(cell) }}</UButton>
        </div>
      </UCard>
    </div>
    <p v-if="!matrix.rows.length" class="py-8 text-center text-text-muted">没有符合筛选条件的学生</p>
  </div>
</template>
