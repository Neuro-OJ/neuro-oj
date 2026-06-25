<script setup lang="ts">
import { FileText } from "@lucide/vue"

const router = useRouter()
const route = useRoute()

interface ProblemItem {
  id: string
  title: string
  description: string
  difficulty: string
  time_limit_ms: number
  memory_limit_mb: number
  acceptance_rate?: number
  categories: { id: string; name: string; slug: string }[]
  display_id: string
  type: string
  owner_id: string
  number: number
  created_at: string
  updated_at: string
}

interface ProblemsResponse {
  data: ProblemItem[]
  total: number
  page: number
  limit: number
}

interface CategoryItem {
  id: string
  name: string
  slug: string
}

// ── 筛选状态（URL 查询参数驱动） ──
const {
  page,
  keyword,
  difficulty,
  categoryId,
  problemType,
  limit,
  hasActiveFilters,
  setFilter,
  queryParams,
} = useProblemFilters()

// ── 获取题目列表 ──
const { data, pending, error, refresh } = useFetch<ProblemsResponse>(
  () => {
    const qs = new URLSearchParams(queryParams.value)
    return `/api/v1/problems?${qs.toString()}`
  },
)

const problems = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => {
  if (total.value === 0) return 0
  return Math.ceil(total.value / limit)
})

// ── 获取分类树（客户端缓存） ──
const { data: categoriesData } = await useAsyncData("problem-categories", () =>
  $fetch<{ data: CategoryItem[] }>("/api/v1/categories"),
)
const categories = computed(() => categoriesData.value?.data ?? [])

// ── 通过状态（仅已登录用户） ──
const { isLoggedIn } = useAuth()
const solvedIds = ref<Set<string>>(new Set())
const attemptedIds = ref<Set<string>>(new Set())
let statusFetchGen = 0

async function fetchUserProblemStatus() {
  if (!isLoggedIn.value) return
  const gen = ++statusFetchGen
  try {
    const res = await $fetch<{
      data: { problem_id: string; result: { score: number } | null }[]
    }>("/api/v1/submissions", {
      query: { per_page: 100 },
    })
    if (gen !== statusFetchGen) return // stale
    const subs = res.data ?? []
    const solved = new Set<string>()
    const attempted = new Set<string>()
    for (const s of subs) {
      if (s.result?.score != null && s.result.score >= 100) {
        solved.add(s.problem_id)
      } else {
        attempted.add(s.problem_id)
      }
    }
    solvedIds.value = solved
    attemptedIds.value = attempted
  } catch {
    // 静默失败——通过状态是可选的
  }
}

watch(isLoggedIn, (loggedIn) => {
  if (loggedIn) fetchUserProblemStatus()
  else {
    solvedIds.value = new Set()
    attemptedIds.value = new Set()
  }
})
if (isLoggedIn.value) fetchUserProblemStatus()

function getProblemStatus(problemId: string): "solved" | "attempted" | "not_started" {
  if (solvedIds.value.has(problemId)) return "solved"
  if (attemptedIds.value.has(problemId)) return "attempted"
  return "not_started"
}

// ── 工具 ──
const difficultyLabel: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

const badgeColors: Record<string, string> = {
  easy: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  hard: "bg-red-100 text-red-700",
}

function formatAcceptanceRate(rate: number | undefined): string {
  if (rate == null) return "--"
  return `${(rate * 100).toFixed(1)}%`
}
</script>

<template>
  <NuxtPage v-if="route.params.id" />
  <div v-else class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-baseline gap-3 mb-6">
      <h1 class="text-2xl font-bold text-text">题库</h1>
      <span class="text-sm text-text-muted">{{ total }} 道题目</span>
    </div>

    <!-- 筛选栏 -->
    <ProblemFilterBar
      :keyword="keyword"
      :difficulty="difficulty"
      :category-id="categoryId"
      :problem-type="problemType"
      :categories="categories"
      @update:keyword="setFilter('keyword', $event)"
      @update:difficulty="setFilter('difficulty', $event)"
      @update:category-id="setFilter('category_id', $event)"
      @update:problem-type="setFilter('type', $event)"
    />

    <!-- 加载中 -->
    <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status" aria-live="polite">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>加载中...</span>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
      <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
      <p>题目加载失败</p>
      <button class="btn btn-outline px-4 py-1.5 text-xs" @click="refresh">重试</button>
    </div>

    <!-- 空数据 -->
    <div v-else-if="problems.length === 0" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status" aria-live="polite">
      <FileText :size="48" class="opacity-30" />
      <p v-if="hasActiveFilters">没有找到符合条件的题目，试试其他筛选条件</p>
      <p v-else>暂无题目</p>
      <button
        v-if="hasActiveFilters"
        class="btn btn-outline px-4 py-1.5 text-xs"
        @click="router.push({ query: {} })"
      >
        清除筛选
      </button>
    </div>

    <!-- 题目表格 -->
    <template v-else>
      <div class="bg-white border border-border rounded-xl overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" class="w-20 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">#</th>
              <th scope="col" class="w-16 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">类型</th>
              <th scope="col" class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">题目</th>
              <th scope="col" class="w-20 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">难度</th>
              <th scope="col" class="w-[120px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">分类</th>
              <th scope="col" class="w-[90px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">时间</th>
              <th scope="col" class="w-[90px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">内存</th>
              <th scope="col" class="w-[80px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">通过率</th>
              <th v-if="isLoggedIn" scope="col" class="w-[80px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">状态</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="problem in problems"
              :key="problem.id"
              tabindex="0"
              role="link"
              class="cursor-pointer transition-colors duration-150 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:ring-inset"
              @click="router.push(`/problems/${problem.id}`)"
              @keydown.enter.prevent="router.push(`/problems/${problem.id}`)"
              @keydown.space.prevent="router.push(`/problems/${problem.id}`)"
            >
              <td class="w-20 px-4 py-3.5">
                <span class="font-mono text-xs text-text-muted">{{ problem.display_id }}</span>
              </td>
              <td class="w-16 px-4 py-3.5">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-purple-100 text-purple-700'"
                >{{ problem.type }}</span>
              </td>
              <td class="px-4 py-3.5">
                <NuxtLink
                  :to="`/problems/${problem.id}`"
                  class="text-text no-underline font-medium hover:text-primary"
                >
                  {{ problem.title }}
                </NuxtLink>
              </td>
              <td class="w-20 px-4 py-3.5">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeColors[problem.difficulty] || ''">
                  {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
                </span>
              </td>
              <td class="w-[120px] px-4 py-3.5 hidden sm:table-cell">
                <span
                  v-for="cat in problem.categories"
                  :key="cat.id"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 mr-1"
                >{{ cat.name }}</span>
                <span v-if="!problem.categories?.length" class="text-xs text-text-muted">--</span>
              </td>
              <td class="w-[90px] px-4 py-3.5 text-xs text-text-secondary hidden sm:table-cell">
                {{ problem.time_limit_ms }}ms
              </td>
              <td class="w-[90px] px-4 py-3.5 text-xs text-text-secondary hidden sm:table-cell">
                {{ problem.memory_limit_mb }}MB
              </td>
              <td class="w-[80px] px-4 py-3.5 hidden sm:table-cell">
                <span class="text-xs text-text-secondary">{{ formatAcceptanceRate(problem.acceptance_rate) }}</span>
              </td>
              <td v-if="isLoggedIn" class="w-[80px] px-4 py-3.5 hidden sm:table-cell">
                <StatusBadge :status="getProblemStatus(problem.id)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <PaginationNav
        :current-page="page"
        :total-pages="totalPages"
        @page-change="setFilter('page', String($event))"
      />
    </template>
  </div>
</template>
