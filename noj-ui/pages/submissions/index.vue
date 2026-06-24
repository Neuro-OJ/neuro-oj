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
  <div class="submissions-page">
    <div class="container">
      <!-- 页面标题 -->
      <div class="page-header">
        <h1 class="page-title">提交历史</h1>
        <p class="page-subtitle">查看你的所有提交记录</p>
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
            <label class="filter-label">提交 ID</label>
            <input
              v-model="filters.submission_id"
              class="filter-input"
              placeholder="输入提交 ID 前缀"
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
          <button class="btn btn-primary btn-sm" @click="applyFilters">
            <Search :size="14" />
            筛选
          </button>
          <button class="btn btn-ghost btn-sm" @click="clearFilters">
            <X :size="14" />
            清空
          </button>
        </div>
      </div>

      <!-- 加载态 -->
      <div v-if="tableLoading" class="state-box">
        <div class="spinner" />
        <span>加载中...</span>
      </div>

      <!-- 错误态 -->
      <div v-else-if="tableError" class="state-box state-error">
        <span>{{ tableError }}</span>
        <button class="btn btn-primary btn-sm" @click="loadSubmissions(currentPage)">重试</button>
      </div>

      <!-- 空态 -->
      <div v-else-if="submissions.length === 0" class="state-box">
        <span>暂无提交记录</span>
      </div>

      <!-- 表格 -->
      <div v-else class="table-wrapper">
        <table class="submissions-table">
          <thead>
            <tr>
              <th class="th th-id">提交 ID</th>
              <th class="th">题目</th>
              <th class="th">语言</th>
              <th class="th">状态</th>
              <th class="th th-num">得分</th>
              <th class="th th-num">耗时</th>
              <th class="th th-num">内存</th>
              <th class="th">提交时间</th>
              <th class="th th-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in submissions" :key="sub.id" class="tr">
              <td class="td td-mono">{{ sub.id.slice(0, 8) }}...</td>
              <td class="td">
                <NuxtLink :to="`/problems/${sub.problem_id}`" class="problem-link">
                  {{ sub.problem.title || sub.problem_id }}
                </NuxtLink>
              </td>
              <td class="td">{{ getLanguageLabel(sub.language) }}</td>
              <td class="td">
                <span
                  class="status-badge"
                  :style="{
                    background: getStatusColor(sub.status, sub.result?.status) + '18',
                    color: getStatusColor(sub.status, sub.result?.status),
                  }"
                >
                  {{ getStatusLabel(sub.status, sub.result?.status) }}
                </span>
              </td>
              <td class="td td-num">
                <template v-if="hasResult(sub)">{{ formatScore(sub.result!.score) }}</template>
                <template v-else>--</template>
              </td>
              <td class="td td-num">
                <template v-if="hasResult(sub)">{{ formatTime(sub.result!.time_ms) }}</template>
                <template v-else>--</template>
              </td>
              <td class="td td-num">
                <template v-if="hasResult(sub)">{{ formatMemory(sub.result!.memory_kb) }}</template>
                <template v-else>--</template>
              </td>
              <td class="td">{{ formatDateTime(sub.created_at) }}</td>
              <td class="td td-action">
                <NuxtLink :to="`/submissions/${sub.id}`" class="btn btn-outline btn-xs">
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

<style scoped>
.submissions-page {
  padding: 32px 0;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--c-text);
  margin: 0;
}

.page-subtitle {
  font-size: 14px;
  color: var(--c-text-secondary);
  margin: 4px 0 0;
}

/* 筛选栏 */
.filter-bar {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
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

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1.5px solid transparent;
  text-decoration: none;
  line-height: 1;
}

.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}

.btn-xs {
  padding: 4px 10px;
  font-size: 12px;
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

.btn-outline {
  color: var(--c-primary);
  border-color: var(--c-primary);
  background: transparent;
}

.btn-outline:hover {
  background: var(--c-primary);
  color: var(--c-white);
}

/* 状态 */
.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  color: var(--c-text-secondary);
  font-size: 14px;
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.state-error {
  color: #dc2626;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--c-border);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 表格 */
.table-wrapper {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow: hidden;
}

.submissions-table {
  width: 100%;
  border-collapse: collapse;
}

.th {
  padding: 12px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: left;
  background: #fafafa;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}

.th-id {
  width: 100px;
}

.th-num {
  width: 70px;
  text-align: right;
}

.th-action {
  width: 80px;
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
  padding: 12px 14px;
  font-size: 13px;
  color: var(--c-text);
}

.td-mono {
  font-family: "SF Mono", "Fira Code", "Fira Mono", monospace;
  font-size: 12px;
  color: var(--c-text-secondary);
}

.td-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.td-action {
  text-align: center;
}

.problem-link {
  color: var(--c-primary);
  text-decoration: none;
  font-weight: 500;
}

.problem-link:hover {
  text-decoration: underline;
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
