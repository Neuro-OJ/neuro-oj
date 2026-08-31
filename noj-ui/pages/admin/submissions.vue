<script setup lang="ts">
import type { SubmissionListItem } from "~/utils/submissionFormat"
import {
  getStatusColor,
  getStatusLabel,
  formatScore,
  formatTime,
  formatMemory,
  getLanguageLabel,
} from "~/utils/submissionFormat"
import { useToast } from "~/composables/useToast"
import { useDialog } from "~/composables/useDialog"
import { extractApiError } from '~/utils/apiError'
import { publicUrl } from '~/utils/publicIdentifiers'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

const { api } = useApi()

const submissions = ref<SubmissionListItem[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20
let requestVersion = 0
const lastRefresh = ref<Date | null>(null)

// 自动轮询间隔（默认 3s，可由刷新控制条切换/关闭）
const pollInterval = ref<number | null>(3000)

// 筛选条件
const filters = reactive({
  problem_search: "",
  submission_id: "",
  user_search: "",
  language: null as string | null,
  status: null as string | null,
})

// 语言选项
const languageOptions = [
  { value: "python3", label: "Python 3" },
  { value: "python", label: "Python" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "javascript", label: "JavaScript" },
]

// 状态选项
const statusOptions = [
  { value: "pending", label: "等待评测" },
  { value: "judging", label: "评测中" },
  { value: "finished", label: "已完成" },
  { value: "error", label: "出错" },
]

// UTable 列 formatter 通过 row 取原始数据行
const columns = [
  { accessorKey: "id", header: "编号", cell: (info) => (info.row.original as SubmissionListItem).public_id || (info.getValue() as string).slice(0, 8) + "..." },
  { accessorKey: "user_id", header: "用户" },
  {
    accessorKey: "problem",
    header: "题目",
    cell: (info) => rowSub(info.row.original).problem.title || rowSub(info.row.original).problem_id,
  },
  { accessorKey: "language", header: "语言", cell: (info) => getLanguageLabel(info.getValue() as string) },
  { accessorKey: "status", header: "状态" },
  {
    accessorKey: "score",
    header: "得分",
    cell: (info) => rowSub(info.row.original).result ? formatScore(rowSub(info.row.original).result!.score) : "--",
  },
  {
    accessorKey: "time_ms",
    header: "耗时",
    cell: (info) => rowSub(info.row.original).result ? formatTime(rowSub(info.row.original).result!.time_ms) : "--",
  },
  {
    accessorKey: "memory_kb",
    header: "内存",
    cell: (info) => rowSub(info.row.original).result ? formatMemory(rowSub(info.row.original).result!.memory_kb) : "--",
  },
  {
    accessorKey: "created_at",
    header: "提交时间",
    cell: (info) => new Date(info.getValue() as string).toLocaleString("zh-CN"),
  },

  { accessorKey: "actions", header: "操作" },]

function buildQuery(page: number): string {
  const params = new URLSearchParams()
  params.set("page", String(page))
  params.set("per_page", String(perPage))
  if (filters.user_search) params.set("user_search", filters.user_search)
  if (filters.problem_search) params.set("problem_search", filters.problem_search)
  if (filters.submission_id) params.set("submission_id", filters.submission_id)
  if (filters.language) params.set("language", filters.language)
  if (filters.status) params.set("status", filters.status)
  return params.toString()
}

/** silent=true 用于轮询：不置 loading、不清错误，失败保留旧数据 */
async function loadSubmissions(page = 1, silent = false) {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  if (!silent) {
    tableLoading.value = true
    tableError.value = ""
  }
  currentPage.value = page
  try {
    const res = await api.get<{ data: SubmissionListItem[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/admin/submissions?${buildQuery(page)}`,
      { silent: true },
    )
    if (currentRequest !== requestVersion) return
    submissions.value = res.data
    totalPages.value = res.pagination.total_pages
    lastRefresh.value = new Date()
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    if (!silent) tableError.value = extractApiError(err).message
  } finally {
    // 无条件复位：避免轮询抢占 requestVersion 后 loading 卡死
    if (currentRequest === requestVersion) tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadSubmissions()
}, { immediate: true })

// 提交列表自动轮询：存在 pending/judging 时每 3s 刷新，全部终态自动停止
const TERMINAL_STATUSES = ["finished", "error"]
const polling = usePolling({
  intervalMs: pollInterval,
  fetcher: () => loadSubmissions(currentPage.value, true),
  immediate: false,
  active: isLoggedIn,
  stopWhen: () =>
    submissions.value.length > 0 &&
    submissions.value.every((s) => TERMINAL_STATUSES.includes(s.status)),
})

function onPageChange(page: number) {
  loadSubmissions(page)
}

function applyFilters() {
  loadSubmissions(1)
}

function clearFilters() {
  filters.user_search = ""
  filters.problem_search = ""
  filters.submission_id = ""
  filters.language = null
  filters.status = null
  loadSubmissions(1)
}

// UTable cell slot 中 row 为原始数据行，辅助函数用于安全取值
function rowSub(row: Record<string, unknown>): SubmissionListItem {
  return row as unknown as SubmissionListItem
}

const toast = useToast()
const { dialog } = useDialog()
const rejudgingIds = ref(new Set<string>())
const removingQueueIds = ref(new Set<string>())

function isRejudging(submissionId: string) {
  return rejudgingIds.value.has(submissionId)
}

async function rejudge(submissionId: string) {
  if (isRejudging(submissionId)) return
  const confirmed = await dialog.confirm(
    "确定要重测该提交吗？将重新运行评测并覆盖现有结果。",
    { title: "确认重测" },
  )
  if (!confirmed) return

  rejudgingIds.value = new Set(rejudgingIds.value).add(submissionId)
  try {
    await api.post(`/api/v1/admin/submissions/${submissionId}/rejudge`)
    toast.showToast("success", "重测任务已提交")
    loadSubmissions(currentPage.value)
    // 重测后列表重新出现 pending，恢复自动轮询
    polling.start()
  } finally {
    const next = new Set(rejudgingIds.value)
    next.delete(submissionId)
    rejudgingIds.value = next
  }
}

function isRemovingQueue(submissionId: string) {
  return removingQueueIds.value.has(submissionId)
}

async function removeFromQueue(submissionId: string) {
  if (isRemovingQueue(submissionId)) return
  const confirmed = await dialog.confirm(
    "该操作会从待处理队列移除任务，并将提交标记为出错。提交记录不会被删除。",
    { title: "确认移出队列" },
  )
  if (!confirmed) return

  removingQueueIds.value = new Set(removingQueueIds.value).add(submissionId)
  try {
    await api.delete(`/api/v1/admin/queue/submissions/${submissionId}`)
    toast.showToast("success", "评测任务已移出队列")
  } catch (err: unknown) {
    toast.showToast("error", extractApiError(err).message)
  } finally {
    const next = new Set(removingQueueIds.value)
    next.delete(submissionId)
    removingQueueIds.value = next
    await loadSubmissions(currentPage.value)
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="提交管理" description="查看所有用户的提交记录">
      <template #actions>
        <RefreshControl
          v-model:interval="pollInterval"
          :last-refresh="lastRefresh"
          @refresh="loadSubmissions(currentPage)"
        />
      </template>
    </PageHeader>

    <!-- 筛选栏 -->
    <div class="bg-white border border-border rounded-lg p-4">
      <div class="flex flex-wrap gap-3 mb-3">
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">题目</label>
          <input
            v-model="filters.problem_search"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
            placeholder="题目 ID 或名称"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">用户</label>
          <input
            v-model="filters.user_search"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
            placeholder="用户名或用户 ID"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">提交 ID</label>
          <input
            v-model="filters.submission_id"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
            placeholder="提交 ID 前缀"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">语言</label>
          <USelect v-model="filters.language" :items="languageOptions" placeholder="全部" class="min-w-[140px]" @change="applyFilters" />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">状态</label>
          <USelect v-model="filters.status" :items="statusOptions" placeholder="全部" class="min-w-[140px]" @change="applyFilters" />
        </div>
      </div>
      <div class="flex gap-2">
        <UButton color="primary" size="sm" class="px-3.5 leading-none" @click="applyFilters">
          <UIcon name="i-lucide-search" class="size-3.5" />
          筛选
        </UButton>
        <UButton color="neutral" variant="outline" size="sm" class="px-3.5 leading-none text-text-secondary border-border hover:border-text-secondary hover:text-text" @click="clearFilters">
          <UIcon name="i-lucide-x" class="size-3.5" />
          清空
        </UButton>
      </div>
    </div>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="submissions"
      :loading="tableLoading"
      :empty="'暂无提交记录'">
      <!-- 状态标签列 -->
      <template #status-cell="{ row }">
        <span
          class="inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
          :style="{
            background: getStatusColor(rowSub(row.original).status, rowSub(row.original).result?.status) + '15',
            color: getStatusColor(rowSub(row.original).status, rowSub(row.original).result?.status),
          }"
        >
          {{ getStatusLabel(rowSub(row.original).status, rowSub(row.original).result?.status) }}
        </span>
      </template>

      <!-- 操作列 -->
      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <button
            v-if="rowSub(row.original).status === 'judging'"
            class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-error-text border-error-text bg-transparent hover:bg-error-text hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isRemovingQueue(rowSub(row.original).public_id || rowSub(row.original).id)"
            @click="removeFromQueue(rowSub(row.original).public_id || rowSub(row.original).id)"
          >{{ isRemovingQueue(rowSub(row.original).public_id || rowSub(row.original).id) ? '移除中...' : '移出队列' }}</button>
          <button class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-warning-text border-warning-text bg-transparent hover:bg-warning-text hover:text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="isRejudging(rowSub(row.original).public_id || rowSub(row.original).id)" @click="rejudge(rowSub(row.original).public_id || rowSub(row.original).id)">{{ isRejudging(rowSub(row.original).public_id || rowSub(row.original).id) ? '提交中...' : '重测' }}</button>
          <NuxtLink :to="publicUrl('submission', rowSub(row.original).public_id || rowSub(row.original).id)" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-primary border-signal bg-transparent hover:bg-signal hover:text-white">查看</NuxtLink>
        </div>
      </template>
    </UTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>
</template>
