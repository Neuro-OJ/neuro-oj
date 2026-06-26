<script setup lang="ts">
import { Loader2, AlertCircle } from "@lucide/vue"

export interface Column<T = Record<string, unknown>> {
  key: string
  label: string
  sortable?: boolean
  format?: (value: unknown, row: T) => string
}

interface Props<T = Record<string, unknown>> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  error?: string
  emptyText?: string
}

defineProps<Props>()
</script>

<template>
  <div class="bg-white border border-border rounded-xl overflow-hidden">
    <!-- 加载态 -->
    <div v-if="loading" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-text-secondary text-sm">
      <Loader2 :size="24" class="animate-spin" />
      <span>加载中...</span>
    </div>

    <!-- 错误态 -->
    <div v-else-if="error" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-red-600 text-sm">
      <AlertCircle :size="20" />
      <span>{{ error }}</span>
    </div>

    <!-- 空态 -->
    <div v-else-if="data.length === 0" class="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-text-secondary text-sm">
      <slot name="empty">
        <span class="text-text-muted">{{ emptyText || "暂无数据" }}</span>
      </slot>
    </div>

    <!-- 表格 -->
    <table v-else class="w-full border-collapse">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key" class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
            {{ col.label }}
          </th>
          <th v-if="$slots.actions" class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-center bg-gray-50 border-b border-border w-[120px]">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIdx) in data" :key="rowIdx" class="border-b border-border last:border-b-0 transition-colors hover:bg-gray-50">
          <td v-for="col in columns" :key="col.key" class="px-4 py-3 text-sm text-text">
            <slot
              :name="`cell-${col.key}`"
              :row="row"
              :value="row[col.key as keyof typeof row]"
            >
              {{ col.format
                ? col.format(row[col.key as keyof typeof row], row)
                : row[col.key as keyof typeof row] ?? "-"
              }}
            </slot>
          </td>
          <td v-if="$slots.actions" class="px-4 py-3 text-sm text-text text-center">
            <slot name="actions" :row="row" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
