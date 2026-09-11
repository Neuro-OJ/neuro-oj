<script setup lang="ts">
/**
 * 通用管理表格：分页、排序、加载/错误/空态、行操作插槽。
 *
 * Nuxt UI v4 的 UTable 用 `data` 接收行数据（v2 的 `rows` 已不是 prop，传入会被
 * 当作普通属性丢弃，表格恒为空），单元格由列定义里的 `cell` 渲染函数产出。
 * 这里按 `columns` 生成列定义，并把单元格 / 操作列委托回本组件对外的
 * `#cell` / `#actions` 插槽，让各管理页保持「一张表一套插槽」的写法。
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

const slots = useSlots()

/** 列定义：cell 渲染函数转发到调用方插槽，未提供插槽时回退为原始值 */
const tableColumns = computed(() =>
  props.columns.map((column) => ({
    accessorKey: column.key,
    header: column.label,
    enableSorting: !!column.sortable,
    cell: (ctx: { row: { original: Record<string, unknown> } }) => {
      const row = ctx.row.original
      if (column.key === "actions" && slots.actions) return slots.actions({ row })
      if (slots.cell) return slots.cell({ row, column })
      const value = row[column.key]
      return value === null || value === undefined ? "" : String(value)
    },
  })),
)

function rowKey(row: Record<string, unknown>): string {
  const key = props.rowKey ?? "id"
  return String(row[key] ?? crypto.randomUUID())
}

/** UTable 的 onSelect 签名为 (event, row)，对外透出原始行数据 */
function onRowSelect(_event: Event, row: { original: Record<string, unknown> }) {
  emit("row-click", row.original)
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
        :data="items"
        :columns="tableColumns"
        :get-row-id="rowKey"
        :on-select="onRowSelect"
      />
      <div v-if="(totalPages ?? 1) > 1" class="flex justify-end px-4 py-3 border-t border-border">
        <UPagination
          :page="currentPage ?? 1"
          :items-per-page="1"
          :total="totalPages ?? 1"
          :show-edges="true"
          size="sm"
          @update:page="(page: number) => emit('update:page', page)"
        />
      </div>
    </template>
  </div>
</template>
