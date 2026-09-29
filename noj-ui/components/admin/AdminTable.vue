<script setup lang="ts">
/**
 * 通用管理表格：支持行选择与批量操作栏、分页、排序、加载/错误/空态、行操作插槽。
 *
 * Nuxt UI v4 的 UTable 用 `data` 接收行数据，单元格由列定义里的 `cell` 渲染函数产出。
 * 这里按 `columns` 生成列定义，并把单元格 / 操作列委托回本组件对外的
 * `#cell` / `#actions` 插槽，让各管理页保持「一张表一套插槽」的写法。
 */
import { Comment, computed, Fragment, h, ref, Text, useSlots } from "vue"

export interface AdminColumn {
  key: string
  label: string
  sortable?: boolean
  width?: string
}

const props = withDefaults(
  defineProps<{
    columns: AdminColumn[]
    items: Record<string, unknown>[]
    loading?: boolean
    error?: string
    totalPages?: number
    currentPage?: number
    totalItems?: number
    rowKey?: string
    selectable?: boolean
    density?: "comfortable" | "compact"
  }>(),
  {
    loading: false,
    error: "",
    totalPages: 1,
    currentPage: 1,
    totalItems: undefined,
    rowKey: "id",
    selectable: false,
    density: "comfortable",
  },
)

const emit = defineEmits<{
  "update:page": [page: number]
  sort: [column: string]
  "row-click": [row: Record<string, unknown>]
}>()

const selected = defineModel<Record<string, unknown>[]>("selected", { default: () => [] })
const slots = useSlots()
const currentDensity = ref<"comfortable" | "compact">(props.density)

function getRowId(row: Record<string, unknown>): string {
  const val = row[props.rowKey]
  return val !== null && val !== undefined ? String(val) : JSON.stringify(row)
}

const isAllSelected = computed(() => {
  if (props.items.length === 0) return false
  const selectedIds = new Set(selected.value.map(getRowId))
  return props.items.every((item) => selectedIds.has(getRowId(item)))
})

const isPartiallySelected = computed(() => {
  if (selected.value.length === 0) return false
  const selectedIds = new Set(selected.value.map(getRowId))
  const someMatch = props.items.some((item) => selectedIds.has(getRowId(item)))
  return someMatch && !isAllSelected.value
})

function toggleSelectAll() {
  if (isAllSelected.value) {
    // 移除当前页所有项
    const currentPageIds = new Set(props.items.map(getRowId))
    selected.value = selected.value.filter((item) => !currentPageIds.has(getRowId(item)))
  } else {
    // 添加当前页所有项（去重）
    const selectedIds = new Set(selected.value.map(getRowId))
    const newlyAdded = props.items.filter((item) => !selectedIds.has(getRowId(item)))
    selected.value = [...selected.value, ...newlyAdded]
  }
}

function toggleSelectRow(row: Record<string, unknown>) {
  const id = getRowId(row)
  const exists = selected.value.some((item) => getRowId(item) === id)
  if (exists) {
    selected.value = selected.value.filter((item) => getRowId(item) !== id)
  } else {
    selected.value = [...selected.value, row]
  }
}

function isRowSelected(row: Record<string, unknown>): boolean {
  const id = getRowId(row)
  return selected.value.some((item) => getRowId(item) === id)
}

function clearSelection() {
  selected.value = []
}

/** 插槽产出是否"真的渲染出了内容" */
function isRendered(node: unknown): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false
  if (typeof node === "string") return node.trim() !== ""
  if (typeof node === "number") return true
  if (Array.isArray(node)) return node.some((child) => isRendered(child))
  const vnode = node as { type?: unknown; children?: unknown }
  if (vnode.type === Comment) return false
  if (vnode.type === Text) return String(vnode.children ?? "").trim() !== ""
  if (vnode.type === Fragment) return isRendered(vnode.children)
  return true
}

/** 列定义：包含行选择列、自定义单元格插槽与回退渲染 */
const tableColumns = computed(() => {
  const cols = []

  // 行选择列
  if (props.selectable) {
    cols.push({
      accessorKey: "__select__",
      header: () =>
        h("div", { class: "flex items-center justify-center pl-2" }, [
          h("input", {
            type: "checkbox",
            class: "accent-primary size-4 cursor-pointer rounded border-border",
            checked: isAllSelected.value,
            indeterminate: isPartiallySelected.value,
            onChange: toggleSelectAll,
            "aria-label": "全选当前页",
          }),
        ]),
      cell: (ctx: { row: { original: Record<string, unknown> } }) => {
        const row = ctx.row.original
        const checked = isRowSelected(row)
        return h("div", { class: "flex items-center justify-center pl-2" }, [
          h("input", {
            type: "checkbox",
            class: "accent-primary size-4 cursor-pointer rounded border-border",
            checked,
            onChange: (e: Event) => {
              e.stopPropagation()
              toggleSelectRow(row)
            },
            "aria-label": "选择此行",
          }),
        ])
      },
    })
  }

  // 业务列
  for (const column of props.columns) {
    cols.push({
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
    })
  }

  return cols
})

function onRowSelect(_event: Event, row: { original: Record<string, unknown> }) {
  emit("row-click", row.original)
}
</script>

<template>
  <div class="flex flex-col bg-white border border-border rounded-lg shadow-card overflow-hidden">
    <!-- 批量操作悬浮工具栏 (Batch Actions Toolbar) -->
    <Transition name="fade">
      <div
        v-if="selectable && selected.length > 0"
        class="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-primary-bg/90 border-b border-primary/20 text-xs"
      >
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-check-square" class="size-4 text-primary" />
          <span class="text-text">
            已选择 <strong class="tabular-nums font-bold text-primary">{{ selected.length }}</strong> 项
          </span>
          <button
            type="button"
            class="text-text-muted hover:text-text underline cursor-pointer ml-2 text-xs"
            @click="clearSelection"
          >
            取消全选
          </button>
        </div>

        <div class="flex items-center gap-2">
          <slot name="batch-actions" :selected="selected" :clear-selection="clearSelection" />
        </div>
      </div>
    </Transition>

    <!-- 加载中状态 -->
    <div v-if="loading" class="flex flex-col items-center justify-center gap-2.5 p-12 text-center text-sm text-text-secondary">
      <UIcon name="i-lucide-loader-2" class="animate-spin size-6 text-primary" />
      <span>加载中...</span>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="error" class="flex flex-col items-center justify-center gap-2.5 p-12 text-center text-sm text-error-text">
      <UIcon name="i-lucide-alert-circle" class="size-6" />
      <span>{{ error }}</span>
    </div>

    <!-- 空数据状态 -->
    <div v-else-if="items.length === 0" class="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-text-muted">
      <UIcon name="i-lucide-inbox" class="size-8 text-text-muted/50" />
      <slot name="empty">暂无数据</slot>
    </div>

    <!-- 表格内容 -->
    <template v-else>
      <div class="overflow-x-auto" :class="currentDensity === 'compact' ? 'table-compact' : ''">
        <UTable
          :data="items"
          :columns="tableColumns"
          :get-row-id="getRowId"
          :on-select="onRowSelect"
          class="w-full"
        />
      </div>

      <!-- 底部控制与分页条 -->
      <div class="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-border bg-bg-page/30 text-xs text-text-secondary">
        <!-- 左侧：统计摘要与密度切换 -->
        <div class="flex items-center gap-3">
          <span class="tabular-nums">
            <template v-if="totalItems !== undefined">
              共 <strong class="font-semibold text-text">{{ totalItems }}</strong> 条记录
            </template>
            <template v-else>
              本页显示 {{ items.length }} 条记录
            </template>
          </span>

          <div class="h-3 w-px bg-border hidden sm:block" />

          <!-- 密度切换按钮 -->
          <div class="hidden sm:flex items-center gap-1 text-[11px]">
            <span class="text-text-muted">密度：</span>
            <button
              type="button"
              class="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
              :class="currentDensity === 'comfortable' ? 'bg-primary text-white font-medium' : 'text-text-muted hover:text-text'"
              @click="currentDensity = 'comfortable'"
            >
              默认
            </button>
            <button
              type="button"
              class="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
              :class="currentDensity === 'compact' ? 'bg-primary text-white font-medium' : 'text-text-muted hover:text-text'"
              @click="currentDensity = 'compact'"
            >
              紧凑
            </button>
          </div>
        </div>

        <!-- 右侧：分页组件 -->
        <div v-if="(totalPages ?? 1) > 1" class="flex items-center gap-2">
          <span class="hidden md:inline text-text-muted tabular-nums">
            第 {{ currentPage ?? 1 }} / {{ totalPages ?? 1 }} 页
          </span>
          <UPagination
            :page="currentPage ?? 1"
            :items-per-page="1"
            :total="totalPages ?? 1"
            :show-edges="true"
            size="sm"
            @update:page="(page: number) => emit('update:page', page)"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.table-compact :deep(td),
.table-compact :deep(th) {
  padding-top: 0.375rem !important;
  padding-bottom: 0.375rem !important;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
