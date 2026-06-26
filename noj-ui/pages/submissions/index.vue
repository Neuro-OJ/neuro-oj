<script setup lang="ts">
import { Search, X } from "@lucide/vue"
import type {
  SubmissionListItem,
} from "~/composables/use-submissions"
import {
  getStatusColor,
  getStatusLabel,
  formatScore,
  formatTime,
  formatMemory,
  getLanguageLabel,
} from "~/composables/use-submissions"

definePageMeta({
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

// 认证守卫：未登录跳转到 /login
watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

// 列表数据
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

function buildQuery(page: number): string {
  const params = new URLSearchParams()
  params.set("page", String(page))
  params.set("per_page", String(perPage))
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
      `/api/v1/submissions?${buildQuery(page)}`,
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
  filters.problem_search = ""
  filters.submission_id = ""
  filters.language = ""
  filters.status = ""
  loadSubmissions(1)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// 根据提交状态判断是否有评测结果可展示
function hasResult(item: SubmissionListItem): boolean {
  return !!(item.result && item.result.status)
}
</script>

<template>
  <div class="py-8">
    <div class="container">
      <!-- 页面标题 -->
      <div class="mb-6">
        <h1 class="m-0 text-2xl font-bold text-text">提交历史</h1>
        <p class="m-0 mt-1 text-sm text-text-secondary">查看你的所有提交记录</p>
      </div>

      <!-- 筛选栏 -->
      <div class="mb-4 rounded-lg border border-border bg-white p-4">
        <div class="mb-3 flex flex-wrap gap-3">
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">题目</label>
            <input
              v-model="filters.problem_search"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              placeholder="题目 ID 或名称"
              @keyup.enter="applyFilters"
            />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">提交 ID</label>
            <input
              v-model="filters.submission_id"
              class="rounded border border-border bg-white px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10"
              placeholder="输入提交 ID 前缀"
              @keyup.enter="applyFilters"
            />
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">语言</label>
            <select v-model="filters.language" class="rounded border border-border bg-white px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10" @change="applyFilters">
              <option v-for="opt in languageOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="flex min-w-[140px] flex-1 flex-col gap-1">
            <label class="text-xs font-semibold text-text-secondary">状态</label>
            <select v-model="filters.status" class="rounded border border-border bg-white px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10" @change="applyFilters">
              <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            class="inline-flex cursor-pointer items-center gap-1 rounded border border-primary bg-primary px-3.5 py-1.5 text-[13px] font-semibold leading-none text-white no-underline transition-all duration-150 hover:border-primary-dark hover:bg-primary-dark"
            @click="applyFilters"
          >
            <Search :size="14" />
            筛选
          </button>
          <button
            class="inline-flex cursor-pointer items-center gap-1 rounded border border-border bg-transparent px-3.5 py-1.5 text-[13px] font-semibold leading-none text-text-secondary no-underline transition-all duration-150 hover:border-text-secondary hover:text-text"
            @click="clearFilters"
          >
            <X :size="14" />
            清空
          </button>
        </div>
      </div>

      <!-- 加载态 -->
      <div v-if="tableLoading" class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-white px-6 py-16 text-sm text-text-secondary">
        <div class="h-6 w-6 animate-spin-slow rounded-full border-[3px] border-border border-t-primary" />
        <span>加载中...</span>
      </div>

      <!-- 错误态 -->
      <div v-else-if="tableError" class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-white px-6 py-16 text-sm text-red-600">
        <span>{{ tableError }}</span>
        <button
          class="inline-flex cursor-pointer items-center gap-1 rounded border border-primary bg-primary px-3.5 py-1.5 text-[13px] font-semibold leading-none text-white no-underline transition-all duration-150 hover:border-primary-dark hover:bg-primary-dark"
          @click="loadSubmissions(currentPage)"
        >
          重试
        </button>
      </div>

      <!-- 空态 -->
      <div v-else-if="submissions.length === 0" class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-white px-6 py-16 text-sm text-text-secondary">
        <span>暂无提交记录</span>
      </div>

      <!-- 表格 -->
      <div v-else class="overflow-hidden rounded-lg border border-border bg-white">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th class="w-[100px] whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">提交 ID</th>
              <th class="whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">题目</th>
              <th class="whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">语言</th>
              <th class="whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">状态</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">得分</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">耗时</th>
              <th class="w-[70px] whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">内存</th>
              <th class="whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">提交时间</th>
              <th class="w-[80px] whitespace-nowrap border-b border-border bg-[#fafafa] px-3.5 py-3 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in submissions" :key="sub.id" class="border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-[#fafafa]">
              <td class="px-3.5 py-3 font-mono text-xs text-text-secondary">{{ sub.id.slice(0, 8) }}...</td>
              <td class="px-3.5 py-3 text-[13px] text-text">
                <NuxtLink :to="`/problems/${sub.problem_id}`" class="font-medium text-primary no-underline hover:underline">
                  {{ sub.problem.title || sub.problem_id }}
                </NuxtLink>
              </td>
              <td class="px-3.5 py-3 text-[13px] text-text">{{ getLanguageLabel(sub.language) }}</td>
              <td class="px-3.5 py-3 text-[13px] text-text">
                <span
                  class="inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold"
                  :style="{
                    background: getStatusColor(sub.status, sub.result?.status) + '18',
                    color: getStatusColor(sub.status, sub.result?.status),
                  }"
                >
                  {{ getStatusLabel(sub.status, sub.result?.status) }}
                </span>
              </td>
              <td class="px-3.5 py-3 text-right text-[13px] tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatScore(sub.result!.score) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-right text-[13px] tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatTime(sub.result!.time_ms) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-right text-[13px] tabular-nums text-text">
                <template v-if="hasResult(sub)">{{ formatMemory(sub.result!.memory_kb) }}</template>
                <template v-else>--</template>
              </td>
              <td class="px-3.5 py-3 text-[13px] text-text">{{ formatDateTime(sub.created_at) }}</td>
              <td class="px-3.5 py-3 text-center text-[13px] text-text">
                <NuxtLink :to="`/submissions/${sub.id}`" class="inline-flex cursor-pointer items-center gap-1 rounded border border-primary bg-transparent px-2.5 py-1 text-xs font-semibold leading-none text-primary no-underline transition-all duration-150 hover:bg-primary hover:text-white">
                  查看
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <PaginationNav
        :current-page="currentPage"
        :total-pages="totalPages"
        @page-change="onPageChange"
      />
    </div>
  </div>
</template>
