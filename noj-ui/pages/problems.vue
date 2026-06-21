<script setup lang="ts">
import { FileText, Clock, Server } from "@lucide/vue"

const route = useRoute()

interface ProblemItem {
  id: string
  title: string
  description: string
  difficulty: string
  time_limit_ms: number
  memory_limit_mb: number
  categories: { id: string; name: string; slug: string }[]
  created_at: string
  updated_at: string
}

interface ProblemsResponse {
  data: ProblemItem[]
  total: number
  page: number
  limit: number
}

const page = ref(1)
const limit = 20

const { data, pending, error } = useFetch<ProblemsResponse>(
  () => `/api/v1/problems?page=${page.value}&limit=${limit}`,
)

const problems = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)))

const difficultyLabel: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

function prevPage() {
  if (page.value > 1) {
    page.value--
  }
}

function nextPage() {
  if (page.value < totalPages.value) {
    page.value++
  }
}
</script>

<template>
  <NuxtPage v-if="route.params.id" />
  <div v-else class="problems-page">
    <div class="page-header">
      <h1 class="page-title">题库</h1>
      <span class="page-count">{{ total }} 道题目</span>
    </div>

    <div v-if="pending" class="loading-state">
      <div class="spinner" />
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="error-state">
      <span class="error-icon">!</span>
      <p>题目加载失败</p>
      <button class="btn btn-outline" @click="refresh">重试</button>
    </div>

    <div v-else-if="problems.length === 0" class="empty-state">
      <FileText :size="48" class="empty-icon" />
      <p>暂无题目</p>
    </div>

    <template v-else>
      <div class="problems-table-wrapper">
        <table class="problems-table">
          <thead>
            <tr>
              <th class="col-id">#</th>
              <th class="col-title">题目</th>
              <th class="col-difficulty">难度</th>
              <th class="col-categories">分类</th>
              <th class="col-meta">时间</th>
              <th class="col-meta">内存</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="problem in problems"
              :key="problem.id"
              class="problem-row"
              @click="$router.push(`/problems/${problem.id}`)"
            >
              <td class="col-id">
                <span class="problem-id">{{ problem.id }}</span>
              </td>
              <td class="col-title">
                <NuxtLink
                  :to="`/problems/${problem.id}`"
                  class="problem-link"
                >
                  {{ problem.title }}
                </NuxtLink>
              </td>
              <td class="col-difficulty">
                <span class="difficulty-badge" :class="problem.difficulty">
                  {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
                </span>
              </td>
              <td class="col-categories">
                <span
                  v-for="cat in problem.categories"
                  :key="cat.id"
                  class="cat-tag"
                >{{ cat.name }}</span>
                <span v-if="!problem.categories?.length" class="no-cat">--</span>
              </td>
              <td class="col-meta">
                <Clock :size="13" />
                {{ problem.time_limit_ms }}ms
              </td>
              <td class="col-meta">
                <Server :size="13" />
                {{ problem.memory_limit_mb }}MB
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button
          class="btn btn-outline btn-sm"
          :disabled="page <= 1"
          @click="prevPage"
        >
          上一页
        </button>
        <span class="page-info">{{ page }} / {{ totalPages }}</span>
        <button
          class="btn btn-outline btn-sm"
          :disabled="page >= totalPages"
          @click="nextPage"
        >
          下一页
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.problems-page {
  padding: 32px 28px;
  max-width: 960px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--c-text);
}

.page-count {
  font-size: 14px;
  color: var(--c-text-muted);
}

/* ── Loading / Error / Empty ── */
.loading-state,
.error-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 24px;
  color: var(--c-text-muted);
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--c-border);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #fee2e2;
  color: #991b1b;
  font-size: 20px;
  font-weight: 700;
}

.empty-icon {
  opacity: 0.3;
}

/* ── Table ── */
.problems-table-wrapper {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  overflow: hidden;
}

.problems-table {
  width: 100%;
  border-collapse: collapse;
}

.problems-table th {
  padding: 12px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  text-align: left;
  background: #f8fafc;
  border-bottom: 1px solid var(--c-border);
}

.problems-table td {
  padding: 14px 16px;
  font-size: 14px;
  border-bottom: 1px solid var(--c-border);
}

.problem-row {
  cursor: pointer;
  transition: background 0.12s;
}

.problem-row:hover {
  background: #f8fafc;
}

.problem-row:last-child td {
  border-bottom: none;
}

.col-id {
  width: 80px;
}

.col-difficulty {
  width: 80px;
}

.col-categories {
  width: 140px;
}

.col-meta {
  width: 100px;
  color: var(--c-text-secondary);
  font-size: 13px;
}

.cat-tag {
  display: inline-flex;
  padding: 1px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 500;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
  margin-right: 4px;
}

.no-cat {
  color: var(--c-text-muted);
  font-size: 12px;
}

.problem-id {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 13px;
  color: var(--c-text-muted);
}

.problem-link {
  color: var(--c-text);
  text-decoration: none;
  font-weight: 500;
}

.problem-link:hover {
  color: var(--c-primary);
}

.difficulty-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
}

.difficulty-badge.easy {
  background: #dcfce7;
  color: #166534;
}

.difficulty-badge.medium {
  background: #fef9c3;
  color: #854d0e;
}

.difficulty-badge.hard {
  background: #fee2e2;
  color: #991b1b;
}

/* ── Pagination ── */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 20px;
}

.btn-sm {
  padding: 6px 16px;
  font-size: 13px;
}

.page-info {
  font-size: 13px;
  color: var(--c-text-muted);
}

.pagination .btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .col-meta {
    display: none;
  }

  .problems-page {
    padding: 20px 16px;
  }
}
</style>
