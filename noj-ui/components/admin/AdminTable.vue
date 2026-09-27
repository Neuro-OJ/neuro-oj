<script setup lang="ts">
/**
 * 通用管理表格：分页、排序、加载/错误/空态、行操作插槽。
 *
 * Nuxt UI v4 的 UTable 用 `data` 接收行数据（v2 的 `rows` 已不是 prop，传入会被
 * 当作普通属性丢弃，表格恒为空），单元格由列定义里的 `cell` 渲染函数产出。
 * 这里按 `columns` 生成列定义，并把单元格 / 操作列委托回本组件对外的
 * `#cell` / `#actions` 插槽，让各管理页保持「一张表一套插槽」的写法。
 *
 * **单元格回退**：调用方的 `#cell` 插槽常常只覆盖需要自定义渲染的列
 * （`v-if` / `v-else-if` 链没有 `v-else`），未命中列产出的是注释占位节点。
 * 此时本组件回退渲染原始字段值，避免整列空白（2026-09 修复：题目管理页的
 * 「题号」「标题」两列曾恒为空）。
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
import { Comment, Fragment, Text } from 'vue'

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

/**
 * 插槽产出是否"真的渲染出了内容"。
 *
 * - `v-if` / `v-else-if` 全部未命中 → Vue 产出注释占位节点（`Comment`）
 * - 命中了但只渲染出空文本（`{{ '' }}`）→ `Text` 节点内容为空
 * - `Fragment` 递归查看子节点
 *
 * 上述情况都视为"该列没有自定义内容"，交由调用方之外的回退渲染原始值。
 */
function isRendered(node: unknown): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return false
  if (typeof node === 'string') return node.trim() !== ''
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some((child) => isRendered(child))
  const vnode = node as { type?: unknown; children?: unknown }
  if (vnode.type === Comment) return false
  if (vnode.type === Text) return String(vnode.children ?? '').trim() !== ''
  if (vnode.type === Fragment) return isRendered(vnode.children)
  return true
}

/** 列定义：cell 渲染函数转发到调用方插槽，未覆盖的列回退为原始值 */
const tableColumns = computed(() =>
  props.columns.map((column) => ({
    accessorKey: column.key,
    header: column.label,
    enableSorting: !!column.sortable,
    cell: (ctx: { row: { original: Record<string, unknown> } }) => {
      const row = ctx.row.original
      if (column.key === "actions" && slots.actions) return slots.actions({ row })
      if (slots.cell) {
        const rendered = slots.cell({ row, column })
        if (isRendered(rendered)) return rendered
      }
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
