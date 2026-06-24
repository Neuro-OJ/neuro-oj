<script setup lang="ts">
import { Loader2, AlertCircle } from "@lucide/vue"

export interface Column<T = Record<string, unknown>> {
  key: string
  label: string
  /** 是否可排序 */
  sortable?: boolean
  /** 自定义单元格渲染函数，返回要显示的内容（字符串）或使用 slot */
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
  <div class="table-wrapper">
    <!-- 加载态 -->
    <div v-if="loading" class="state-box">
      <Loader2 :size="24" class="spin" />
      <span>加载中...</span>
    </div>

    <!-- 错误态 -->
    <div v-else-if="error" class="state-box error">
      <AlertCircle :size="20" />
      <span>{{ error }}</span>
    </div>

    <!-- 空态 -->
    <div v-else-if="data.length === 0" class="state-box">
      <slot name="empty">
        <span class="empty-text">{{ emptyText || "暂无数据" }}</span>
      </slot>
    </div>

    <!-- 表格 -->
    <table v-else class="admin-table">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key" class="th">
            {{ col.label }}
          </th>
          <th v-if="$slots.actions" class="th actions-th">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIdx) in data" :key="rowIdx" class="tr">
          <td v-for="col in columns" :key="col.key" class="td">
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
          <td v-if="$slots.actions" class="td actions-td">
            <slot name="actions" :row="row" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrapper {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow: hidden;
}

.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 24px;
  color: var(--c-text-secondary);
  font-size: 14px;
}

.state-box.error {
  color: #dc2626;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-text {
  color: var(--c-text-muted);
}

.admin-table {
  width: 100%;
  border-collapse: collapse;
}

.th {
  padding: 12px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: left;
  background: #fafafa;
  border-bottom: 1px solid var(--c-border);
}

.actions-th {
  width: 120px;
  text-align: center;
}

.tr {
  border-bottom: 1px solid var(--c-border);
  transition: background 0.15s;
}

.tr:last-child {
  border-bottom: none;
}

.tr:hover {
  background: #fafafa;
}

.td {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--c-text);
}

.actions-td {
  text-align: center;
}
</style>
