<script setup lang="ts">
import type { SubmissionListItem } from "~/composables/use-submissions"
import {
  getStatusColor,
  getStatusLabel,
  formatScore,
  formatTime,
  formatMemory,
  getLanguageLabel,
} from "~/composables/use-submissions"
import { useToast } from "~/composables/useToast"
import { useDialog } from "~/composables/useDialog"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

const submissions = ref<SubmissionListItem[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20
let requestVersion = 0

// 筛选条件
const filters = reactive({
  problem_search: "",
  submission_id: "",
  user_search: "",
  language: "",
  status: "",
})

// 语言选项
const languageOptions = [
  { value: "", header: "全部" },
  { value: "python3", header: "Python 3" },
  { value: "python", header: "Python" },
  { value: "cpp", header: "C++" },
  { value: "c", header: "C" },
  { value: "javascript", header: "JavaScript" },
]

// 状态选项
const statusOptions = [
  { value: "", header: "全部" },
  { value: "pending", header: "等待评测" },
  { value: "judging", header: "评测中" },
  { value: "finished", header: "已完成" },
  { value: "error", header: "出错" },
]

// UTable 列 formatter 通过 row 取原始数据行
const columns = [
  { accessorKey: "id", header: "编号", cell: (info) => (info.getValue() as string).slice(0, 8) + "..." },
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

async function loadSubmissions(page = 1) {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: SubmissionListItem[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/admin/submissions?${buildQuery(page)}`,
    )
    if (currentRequest !== requestVersion) return
    submissions.value = res.data
    totalPages.value = res.pagination.total_pages
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    tableError.value = err instanceof Error ? err.message : "加载提交记录失败"
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadSubmissions()
}, { immediate: true })

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
  filters.language = ""
  filters.status = ""
  loadSubmissions(1)
}

// UTable cell slot 中 row 为原始数据行，辅助函数用于安全取值
function rowSub(row: Record<string, unknown>): SubmissionListItem {
  return row as unknown as SubmissionListItem
}

const toast = useToast()
const { dialog } = useDialog()
const rejudgingIds = ref(new Set<string>())

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
    await $fetch(`/api/v1/admin/submissions/${submissionId}/rejudge`, {
      method: "POST",
    })
    toast.showToast("success", "重测任务已提交")
    loadSubmissions(currentPage.value)
  } catch (err: unknown) {
    toast.showToast(
      "error",
      err instanceof Error ? err.message : "重测失败",
    )
  } finally {
    const next = new Set(rejudgingIds.value)
    next.delete(submissionId)
    rejudgingIds.value = next
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="提交管理" description="查看所有用户的提交记录" />

    <!-- 筛选栏 -->
    <div class="bg-white border border-border rounded-lg p-4">
      <div class="flex flex-wrap gap-3 mb-3">
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">题目</label>
          <input
            v-model="filters.problem_search"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="题目 ID 或名称"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">用户</label>
          <input
            v-model="filters.user_search"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="用户名或用户 ID"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">提交 ID</label>
          <input
            v-model="filters.submission_id"
            class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="提交 ID 前缀"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">语言</label>
          <select v-model="filters.language" class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" @change="applyFilters">
            <option v-for="opt in languageOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">状态</label>
          <select v-model="filters.status" class="px-2.5 py-1.5 text-13px border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" @change="applyFilters">
            <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
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
            background: getStatusColor(rowSub(row).status, rowSub(row).result?.status) + '15',
            color: getStatusColor(rowSub(row).status, rowSub(row).result?.status),
          }"
        >
          {{ getStatusLabel(rowSub(row).status, rowSub(row).result?.status) }}
        </span>
      </template>

      <!-- 操作列 -->
      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <button class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-warning-text border-warning-text bg-transparent hover:bg-warning-text hover:text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="isRejudging(rowSub(row).id)" @click="rejudge(rowSub(row).id)">{{ isRejudging(rowSub(row).id) ? '提交中...' : '重测' }}</button>
          <NuxtLink :to="`/submissions/${rowSub(row).id}`" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-primary border-primary bg-transparent hover:bg-primary hover:text-white">查看</NuxtLink>
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
