<script setup lang="ts">
import { Copy, ScrollText } from "@lucide/vue"
import { useAuditLogs } from "~/composables/useAuditLogs"
import type { AuditAction, AuditLogEntry } from "~/composables/useAuditLogs"
import { useToast } from "~/composables/useToast"

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
  "categories.delete": "删除分类",
  "submissions.rejudge": "重测提交",
  "settings.update": "修改设置",
}

const ACTION_COLORS: Record<AuditAction, string> = {
  "users.role_change": "bg-blue-100 text-blue-800",
  "users.ban": "bg-red-100 text-red-800",
  "users.unban": "bg-green-100 text-green-800",
  "problems.delete": "bg-red-100 text-red-800",
  "categories.delete": "bg-orange-100 text-orange-800",
  "submissions.rejudge": "bg-purple-100 text-purple-800",
  "settings.update": "bg-yellow-100 text-yellow-800",
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
    case "categories.delete":
      return `${d.name} (${d.slug})`
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

function onPageChange(page: number) {
  filters.value.page = page
  fetch()
}

const totalPages = computed(() =>
  Math.max(1, Math.ceil(pagination.value.total / pagination.value.per_page)),
)

onMounted(fetch)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text flex items-center gap-2">
        <ScrollText :size="22" />
        审计日志
      </h1>
      <span class="text-sm text-text-secondary">查看管理员操作的完整审计记录（保留 90 天）</span>
    </div>

    <!-- 筛选条 -->
    <div class="bg-white border border-border rounded-lg p-4">
      <div class="flex flex-wrap gap-3 mb-3">
        <div class="flex flex-col gap-1 min-w-[180px]">
          <label class="text-xs font-semibold text-text-secondary">操作类型</label>
          <select
            v-model="filters.action"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          >
            <option value="">全部</option>
            <option v-for="(label, action) in ACTION_LABELS" :key="action" :value="action">
              {{ label }}
            </option>
          </select>
        </div>
        <div class="flex flex-col gap-1 min-w-[200px]">
          <label class="text-xs font-semibold text-text-secondary">起始时间</label>
          <input
            type="datetime-local"
            v-model="filters.from"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[200px]">
          <label class="text-xs font-semibold text-text-secondary">截止时间</label>
          <input
            type="datetime-local"
            v-model="filters.to"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          />
        </div>
      </div>
      <div class="flex gap-2">
        <button
          class="inline-flex items-center gap-1 px-3.5 py-1.5 text-[13px] font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline bg-primary text-white border-primary hover:bg-primary-dark hover:border-primary-dark"
          @click="applyFilters"
        >
          筛选
        </button>
        <button
          class="inline-flex items-center gap-1 px-3.5 py-1.5 text-[13px] font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-text-secondary border-border bg-transparent hover:border-text-secondary hover:text-text"
          @click="reset(); fetch()"
        >
          重置
        </button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <table class="w-full border-collapse">
        <thead>
          <tr>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              时间
            </th>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              管理员
            </th>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              操作
            </th>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              目标
            </th>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              详情
            </th>
            <th class="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider text-left bg-gray-50 border-b border-border">
              IP
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="px-4 py-12 text-center text-text-secondary text-sm">
              加载中...
            </td>
          </tr>
          <tr v-else-if="error">
            <td colspan="6" class="px-4 py-12 text-center text-red-600 text-sm">
              {{ error }}
            </td>
          </tr>
          <tr v-else-if="data.length === 0">
            <td colspan="6" class="px-4 py-12 text-center text-text-muted text-sm">
              暂无记录
            </td>
          </tr>
          <tr
            v-for="entry in data"
            v-else
            :key="entry.id"
            class="border-b border-border last:border-b-0 transition-colors hover:bg-gray-50"
          >
            <td class="px-4 py-3 text-sm text-text whitespace-nowrap">
              {{ new Date(entry.created_at).toLocaleString("zh-CN") }}
            </td>
            <td class="px-4 py-3 text-sm font-mono text-text-secondary">
              {{ entry.admin_id.slice(0, 8) }}...
            </td>
            <td class="px-4 py-3 text-sm">
              <span :class="['inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap', ACTION_COLORS[entry.action]]">
                {{ ACTION_LABELS[entry.action] }}
              </span>
            </td>
            <td class="px-4 py-3 text-sm text-text-secondary">
              {{ entry.target_type }}:{{ entry.target_id?.slice(0, 8) }}...
            </td>
            <td class="px-4 py-3 text-sm text-text">
              {{ renderDetail(entry) }}
            </td>
            <td class="px-4 py-3 text-sm text-text-secondary font-mono">
              <span class="inline-flex items-center gap-1">
                {{ entry.ip_address }}
                <button
                  class="inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-text-muted hover:text-primary hover:bg-primary-bg"
                  title="复制 IP"
                  @click="copy(entry.ip_address)"
                >
                  <Copy :size="13" />
                </button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <PaginationNav
      v-if="pagination.total > pagination.per_page"
      :current-page="pagination.page"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>
</template>
