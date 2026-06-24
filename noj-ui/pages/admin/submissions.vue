<script setup lang="ts">
import { Search, X, Filter } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"

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

interface Submission {
  id: string
  user_id: string
  problem_id: string
  language: string
  status: string
  created_at: string
}

const submissions = ref<Submission[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20

// 筛选条件
const filters = reactive({
  user_id: "",
  problem_id: "",
  language: "",
  status: "",
  from: "",
  to: "",
})

const statusLabels: Record<string, string> = {
  pending: "等待中",
  judging: "评测中",
  finished: "已完成",
  error: "出错",
}

const statusColors: Record<string, string> = {
  pending: "#f59e0b",
  judging: "#3b82f6",
  finished: "#10b981",
  error: "#ef4444",
}

const columns: Column<Submission>[] = [
  { key: "id", label: "编号", format: (val) => (val as string).slice(0, 8) + "..." },
  { key: "user_id", label: "用户" },
  { key: "problem_id", label: "题目" },
  { key: "language", label: "语言" },
  {
    key: "status",
    label: "状态",
    format: (val) => statusLabels[val as string] || (val as string),
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
  if (filters.user_id) params.set("user_id", filters.user_id)
  if (filters.problem_id) params.set("problem_id", filters.problem_id)
  if (filters.language) params.set("language", filters.language)
  if (filters.status) params.set("status", filters.status)
  if (filters.from) params.set("from", filters.from)
  if (filters.to) params.set("to", filters.to)
  return params.toString()
}

async function loadSubmissions(page = 1) {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: Submission[]; pagination: { total: number; total_pages: number } }>(
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
  filters.user_id = ""
  filters.problem_id = ""
  filters.language = ""
  filters.status = ""
  filters.from = ""
  filters.to = ""
  loadSubmissions(1)
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
          <label class="filter-label">用户 ID</label>
          <input v-model="filters.user_id" class="filter-input" placeholder="user_id" @keyup.enter="applyFilters" />
        </div>
        <div class="filter-item">
          <label class="filter-label">题目 ID</label>
          <input v-model="filters.problem_id" class="filter-input" placeholder="problem_id" @keyup.enter="applyFilters" />
        </div>
        <div class="filter-item">
          <label class="filter-label">语言</label>
          <input v-model="filters.language" class="filter-input" placeholder="如 python3" @keyup.enter="applyFilters" />
        </div>
        <div class="filter-item">
          <label class="filter-label">状态</label>
          <select v-model="filters.status" class="filter-input" @change="applyFilters">
            <option value="">全部</option>
            <option value="pending">等待中</option>
            <option value="judging">评测中</option>
            <option value="finished">已完成</option>
            <option value="error">出错</option>
          </select>
        </div>
        <div class="filter-item">
          <label class="filter-label">开始时间</label>
          <input v-model="filters.from" type="date" class="filter-input" />
        </div>
        <div class="filter-item">
          <label class="filter-label">结束时间</label>
          <input v-model="filters.to" type="date" class="filter-input" />
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
      <template #cell-status="{ row }">
        <span class="status-badge" :style="{ background: statusColors[row.status] + '15', color: statusColors[row.status] }">
          {{ statusLabels[row.status] || row.status }}
        </span>
      </template>

      <template #actions="{ row }">
        <NuxtLink :to="`/submissions/${row.id}`" class="btn btn-xs">查看</NuxtLink>
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
}
</style>
