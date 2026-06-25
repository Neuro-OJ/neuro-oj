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
  <div class="page">
    <div class="header">
      <h1 class="title">提交管理</h1>
      <span class="subtitle">查看所有用户的提交记录</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <div class="filter-row">
        <div class="filter-item">
          <label class="filter-label">题目</label>
          <input
            v-model="filters.problem_search"
            class="filter-input"
            placeholder="题目 ID 或名称"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="filter-item">
          <label class="filter-label">用户</label>
          <input
            v-model="filters.user_search"
            class="filter-input"
            placeholder="用户名或用户 ID"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="filter-item">
          <label class="filter-label">提交 ID</label>
          <input
            v-model="filters.submission_id"
            class="filter-input"
            placeholder="提交 ID 前缀"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="filter-item">
          <label class="filter-label">语言</label>
          <select v-model="filters.language" class="filter-input" @change="applyFilters">
            <option v-for="opt in languageOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="filter-item">
          <label class="filter-label">状态</label>
          <select v-model="filters.status" class="filter-input" @change="applyFilters">
            <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="filter-actions">
        <button class="btn btn-primary" @click="applyFilters">
          <Search :size="14" />
          筛选
        </button>
        <button class="btn btn-ghost" @click="clearFilters">
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
      <!-- 状态标签列：评测结果状态优先，提交状态回退 -->
      <template #cell-status="{ row }">
        <span
          class="status-badge"
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
        <NuxtLink :to="`/submissions/${rowSub(row).id}`" class="btn btn-xs">查看</NuxtLink>
      </template>
    </AdminTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
}

.subtitle {
  font-size: 14px;
  color: var(--c-text-secondary);
}

/* 筛选栏 */
.filter-bar {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 16px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
  flex: 1;
}

.filter-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-secondary);
}

.filter-input {
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  outline: none;
  background: var(--c-white);
  transition: border-color 0.15s;
}

.filter-input:focus {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.filter-actions {
  display: flex;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1.5px solid transparent;
  line-height: 1;
  text-decoration: none;
}

.btn-primary {
  background: var(--c-primary);
  color: var(--c-white);
  border-color: var(--c-primary);
}

.btn-primary:hover {
  background: var(--c-primary-dark);
  border-color: var(--c-primary-dark);
}

.btn-ghost {
  color: var(--c-text-secondary);
  border-color: var(--c-border);
  background: transparent;
}

.btn-ghost:hover {
  border-color: var(--c-text-secondary);
  color: var(--c-text);
}

.btn-xs {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--c-primary);
  border-color: var(--c-primary);
  background: transparent;
}

.btn-xs:hover {
  background: var(--c-primary);
  color: var(--c-white);
}

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
</style>
