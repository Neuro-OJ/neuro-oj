<script setup lang="ts">
import { useAuditLogs } from "~/composables/useAuditLogs"
import type { AuditAction, AuditLogEntry } from "~/composables/useAuditLogs"
import { useToast } from "~/composables/useToast"
import type { AdminColumn } from "~/components/admin/AdminTable.vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { filters, data, pagination, loading, error, fetch, reset } = useAuditLogs()
const { toast } = useToast()

const ACTION_LABELS: Record<AuditAction, string> = {
  "users.role_change": "角色变更",
  "users.ban": "用户封禁",
  "users.unban": "用户解封",
  "problems.delete": "删除题目",
  "tags.create": "创建标签",
  "tags.update": "更新标签",
  "tags.delete": "删除标签",
  "tags.merge": "合并标签",
  "submissions.rejudge": "重测提交",
  "settings.update": "修改设置",
}

const ACTION_COLORS: Record<AuditAction, string> = {
  "users.role_change": "bg-blue-100 text-blue-800",
  "users.ban": "bg-red-100 text-red-800",
  "users.unban": "bg-green-100 text-green-800",
  "problems.delete": "bg-red-100 text-red-800",
  "tags.create": "bg-blue-100 text-blue-800",
  "tags.update": "bg-gray-100 text-gray-800",
  "tags.delete": "bg-gray-100 text-gray-800",
  "tags.merge": "bg-blue-100 text-blue-800",
  "submissions.rejudge": "bg-purple-100 text-purple-800",
  "settings.update": "bg-yellow-100 text-yellow-800",
}

const columns: AdminColumn[] = [
  { key: "created_at", label: "时间" },
  { key: "admin_id", label: "管理员" },
  { key: "action", label: "操作" },
  { key: "target", label: "目标" },
  { key: "detail", label: "详情" },
  { key: "ip_address", label: "IP" },
]

/** 操作名展示：已知管理操作走中文映射，其余（如 auth.* 系统事件）回退原始 action */
function actionLabel(action: string): string {
  return ACTION_LABELS[action as AuditAction] ?? action
}

/** 目标列展示：target_type/target_id 均可为 null，需判空 */
function targetText(row: Record<string, unknown>): string {
  if (!row.target_type && !row.target_id) return "—"
  const id = row.target_id ? `${String(row.target_id).slice(0, 8)}...` : ""
  return `${row.target_type ?? ""}${row.target_type && id ? ":" : ""}${id}`
}

function renderDetail(entry: AuditLogEntry): string {
  const d = entry.detail as Record<string, any>
  switch (entry.action) {
    case "users.role_change":
      return `${d.from} → ${d.to}`
    case "users.ban":
      return `${d.reason}${d.until ? ` (至 ${d.until})` : ""}`
    case "users.unban":
      return "已解封"
    case "problems.delete":
      return `${d.title} (${d.display_id})`
    case "tags.create":
      return `${d.name} (${d.kind})`
    case "tags.update":
      return `${d.from} → ${d.to}`
    case "tags.delete":
      return `${d.name} (${d.kind})`
    case "tags.merge":
      return `${d.source_name} → ${d.target_name}`
    case "submissions.rejudge":
      if (d.submission_id) return `submission: ${d.submission_id}`
      if (d.problem_id) return `problem: ${d.problem_id} (×${d.count ?? "?"})`
      return "—"
    case "settings.update":
      return `${d.key}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`
    default:
      return JSON.stringify(d)
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success("已复制")
  } catch {
    toast.error("复制失败")
  }
}

function applyFilters() {
  filters.value.page = 1
  fetch()
}

function onReset() {
  reset()
  fetch()
}

function onPageChange(page: number) {
  filters.value.page = page
  fetch()
}

const totalPages = computed(() =>
  Math.max(1, Math.ceil(pagination.value.total / pagination.value.per_page)),
)

const tableItems = computed(() => data.value as unknown as Record<string, unknown>[])

onMounted(fetch)
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader
      title="审计日志"
      description="查看管理员操作的完整审计记录（保留 90 天）"
      icon="i-lucide-scroll-text"
    />

    <AdminFilterBar @search="applyFilters" @reset="onReset">
      <div class="flex flex-col gap-1 min-w-[180px]">
        <label class="text-xs font-semibold text-text-secondary">操作类型</label>
        <USelect
          v-model="filters.action"
          :items="Object.entries(ACTION_LABELS).map(([value, label]) => ({ label, value }))"
          placeholder="全部"
          class="min-w-[180px]"
        />
      </div>
      <div class="flex flex-col gap-1 min-w-[200px]">
        <label class="text-xs font-semibold text-text-secondary">起始时间</label>
        <input
          type="datetime-local"
          v-model="filters.from"
          class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        />
      </div>
      <div class="flex flex-col gap-1 min-w-[200px]">
        <label class="text-xs font-semibold text-text-secondary">截止时间</label>
        <input
          type="datetime-local"
          v-model="filters.to"
          class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        />
      </div>
    </AdminFilterBar>

    <AdminTable
      :columns="columns"
      :items="tableItems"
      :loading="loading"
      :error="error ?? undefined"
      :total-pages="totalPages"
      :current-page="pagination.page"
      @update:page="onPageChange"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'created_at'">
          {{ new Date(row.created_at as string).toLocaleString("zh-CN") }}
        </template>
        <template v-else-if="column.key === 'admin_id'">
          <!-- admin_id 可为 null（系统自动事件，如 auth.register），必须判空 -->
          <span class="font-mono text-text-secondary">{{ row.admin_id ? `${(row.admin_id as string).slice(0, 8)}...` : "系统" }}</span>
        </template>
        <template v-else-if="column.key === 'action'">
          <span :class="['inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap', ACTION_COLORS[row.action as AuditAction] ?? 'bg-gray-100 text-gray-700']">
            {{ actionLabel(row.action as string) }}
          </span>
        </template>
        <template v-else-if="column.key === 'target'">
          <span class="text-text-secondary">{{ targetText(row) }}</span>
        </template>
        <template v-else-if="column.key === 'detail'">
          {{ renderDetail(row as unknown as AuditLogEntry) }}
        </template>
        <template v-else-if="column.key === 'ip_address'">
          <span class="inline-flex items-center gap-1 font-mono">
            {{ row.ip_address }}
            <button
              class="inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-text-muted hover:text-primary hover:bg-primary-bg"
              title="复制 IP"
              @click="copy(row.ip_address as string)"
            >
              <UIcon name="i-lucide-copy" class="size-3" />
            </button>
          </span>
        </template>
      </template>
    </AdminTable>
  </div>
</template>
