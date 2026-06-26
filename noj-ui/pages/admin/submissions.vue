<script setup lang="ts">
import { Search, X } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"
import type { SubmissionListItem } from "~/composables/use-submissions"
import {
  getStatusColor,
  getStatusLabel,
  formatScore,
  formatTime,
  formatMemory,
  getLanguageLabel,
} from "~/composables/use-submissions"

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
  { value: "", label: "全部" },
  { value: "python3", label: "Python 3" },
  { value: "python", label: "Python" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "javascript", label: "JavaScript" },
]

// 状态选项
const statusOptions = [
  { value: "", label: "全部" },
  { value: "pending", label: "等待评测" },
  { value: "judging", label: "评测中" },
  { value: "finished", label: "已完成" },
  { value: "error", label: "出错" },
]

// AdminTable 的 Column 泛型默认为 Record<string, unknown>，format 中通过 rowSub 取值
const columns: Column[] = [
  { key: "id", label: "编号", format: (val) => (val as string).slice(0, 8) + "..." },
  { key: "user_id", label: "用户" },
  {
    key: "problem",
    label: "题目",
    format: (_, row) => rowSub(row).problem.title || rowSub(row).problem_id,
  },
  { key: "language", label: "语言", format: (val) => getLanguageLabel(val as string) },
  { key: "status", label: "状态" },
  {
    key: "score",
    label: "得分",
    format: (_, row) => rowSub(row).result ? formatScore(rowSub(row).result!.score) : "--",
  },
  {
    key: "time_ms",
    label: "耗时",
    format: (_, row) => rowSub(row).result ? formatTime(rowSub(row).result!.time_ms) : "--",
  },
  {
    key: "memory_kb",
    label: "内存",
    format: (_, row) => rowSub(row).result ? formatMemory(rowSub(row).result!.memory_kb) : "--",
  },
  {
    key: "created_at",
    label: "提交时间",
    format: (val) => new Date(val as string).toLocaleString("zh-CN"),
  },
]

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
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: SubmissionListItem[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/admin/submissions?${buildQuery(page)}`,
    )
    submissions.value = res.data
    totalPages.value = res.pagination.total_pages
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载提交记录失败"
  } finally {
    tableLoading.value = false
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

// AdminTable slot 中 row 类型为 Record<string, unknown>，辅助函数用于安全取值
function rowSub(row: Record<string, unknown>): SubmissionListItem {
  return row as unknown as SubmissionListItem
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text">提交管理</h1>
      <span class="text-sm text-text-secondary">查看所有用户的提交记录</span>
    </div>

    <!-- 筛选栏 -->
    <div class="bg-white border border-border rounded-lg p-4">
      <div class="flex flex-wrap gap-3 mb-3">
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">题目</label>
          <input
            v-model="filters.problem_search"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="题目 ID 或名称"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">用户</label>
          <input
            v-model="filters.user_search"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="用户名或用户 ID"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">提交 ID</label>
          <input
            v-model="filters.submission_id"
            class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
            placeholder="提交 ID 前缀"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">语言</label>
          <select v-model="filters.language" class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" @change="applyFilters">
            <option v-for="opt in languageOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="flex flex-col gap-1 min-w-[140px] flex-1">
          <label class="text-xs font-semibold text-text-secondary">状态</label>
          <select v-model="filters.status" class="px-2.5 py-1.5 text-[13px] border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" @change="applyFilters">
            <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="inline-flex items-center gap-1 px-3.5 py-1.5 text-[13px] font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline bg-primary text-white border-primary hover:bg-primary-dark hover:border-primary-dark" @click="applyFilters">
          <Search :size="14" />
          筛选
        </button>
        <button class="inline-flex items-center gap-1 px-3.5 py-1.5 text-[13px] font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-text-secondary border-border bg-transparent hover:border-text-secondary hover:text-text" @click="clearFilters">
          <X :size="14" />
          清空
        </button>
      </div>
    </div>

    <AdminTable
      :columns="columns"
      :data="submissions"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无提交记录"
    >
      <!-- 状态标签列 -->
      <template #cell-status="{ row }">
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
      <template #actions="{ row }">
        <NuxtLink :to="`/submissions/${rowSub(row).id}`" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] leading-none no-underline text-primary border-primary bg-transparent hover:bg-primary hover:text-white">查看</NuxtLink>
      </template>
    </AdminTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>
</template>
