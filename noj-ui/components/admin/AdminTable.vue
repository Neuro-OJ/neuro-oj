<script setup lang="ts">
/**
 * 通用管理表格：分页、排序、加载/错误/空态、行操作插槽。
 *
 * 用法：
 * ```vue
 * <AdminTable
 *   :columns="columns"
 *   :items="items"
 *   :loading="loading"
 *   :error="error"
 *   :total-pages="totalPages"
 *   :current-page="currentPage"
 *   @update:page="onPageChange"
 * >
 *   <template #cell="{ row, column }">...</template>
 *   <template #actions="{ row }">...</template>
 * </AdminTable>
 * ```
 */
export interface AdminColumn {
  key: string
  label: string
  sortable?: boolean
  width?: string
}

const props = defineProps<{
  columns: AdminColumn[]
  items: Record<string, unknown>[]
  loading?: boolean
  error?: string
  totalPages?: number
  currentPage?: number
  rowKey?: string
}>()

const emit = defineEmits<{
  "update:page": [page: number]
  sort: [column: string]
  "row-click": [row: Record<string, unknown>]
}>()

const sort = ref<{ column: string; direction: "asc" | "desc" } | null>(null)

function onSort(column: AdminColumn) {
  if (!column.sortable) return
  const next = sort.value?.column === column.key && sort.value.direction === "asc"
    ? "desc"
    : "asc"
  sort.value = { column: column.key, direction: next }
  emit("sort", column.key)
}

function rowKey(row: Record<string, unknown>): string {
  const key = props.rowKey ?? "id"
  return String(row[key] ?? crypto.randomUUID())
}
</script>

<template>
  <div class="bg-white border border-border rounded-xl overflow-hidden">
    <div v-if="loading" class="p-8 text-center text-sm text-text-secondary">
      加载中...
    </div>
    <div v-else-if="error" class="p-8 text-center text-sm text-error-text">
      {{ error }}
    </div>
    <div v-else-if="items.length === 0" class="p-8 text-center text-sm text-text-muted">
      <slot name="empty">暂无数据</slot>
    </div>
    <template v-else>
      <UTable
        :rows="items"
        :columns="columns.map((c) => ({ key: c.key, label: c.label, sortable: c.sortable }))"
        :ui="{ tr: { base: 'hover:bg-primary-bg cursor-pointer' } }"
        @select="(row: Record<string, unknown>) => emit('row-click', row)"
      >
        <template #default="{ row, column }">
          <slot name="cell" :row="row" :column="column">
            <span @click="onSort(column as AdminColumn)" :class="column.sortable ? 'cursor-pointer' : ''">
              {{ row[column.key] }}
            </span>
          </slot>
        </template>
        <template #actions="{ row }">
          <slot name="actions" :row="row" />
        </template>
      </UTable>
      <div v-if="!loading && (totalPages ?? 1) > 1" class="flex justify-end px-4 py-3 border-t border-border">
        <UPagination
          :model-value="currentPage ?? 1"
          :page-count="1"
          :total="(totalPages ?? 1) * 10"
          @update:model-value="(p: number) => emit('update:page', p)"
        />
      </div>
    </template>
  </div>
</template>
