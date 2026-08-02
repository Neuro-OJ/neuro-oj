<script setup lang="ts">
const { api } = useApi()

const router = useRouter()
const route = useRoute()

interface ProblemItem {
  id: string
  title: string
  description: string
  difficulty: string
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
  api.get<{ data: CategoryItem[] }>("/api/v1/categories", { silent: true }),
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
    const res = await api.get<{
      data: { problem_id: string; result: { score: number } | null }[]
    }>("/api/v1/submissions", {
      query: { per_page: 100 },
      silent: true,
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

// 响应式列：sm 以下隐藏次要列（对齐原 hidden sm:table-cell 行为）
const isDesktop = ref(false)
function updateIsDesktop() {
  isDesktop.value = window.matchMedia("(min-width: 640px)").matches
}
onMounted(() => {
  updateIsDesktop()
  window.addEventListener("resize", updateIsDesktop)
})
onUnmounted(() => window.removeEventListener("resize", updateIsDesktop))

const columns = computed(() => {
  const base: { accessorKey: string; header: string }[] = [
    { accessorKey: "display_id", header: "#" },
    { accessorKey: "title", header: "题目" },
    { accessorKey: "difficulty", header: "难度" },
    { accessorKey: "categories", header: "分类" },
    { accessorKey: "time", header: "时间" },
    { accessorKey: "memory", header: "内存" },
    { accessorKey: "rate", header: "通过率" },
  ]
  if (isLoggedIn.value) base.push({ accessorKey: "status", header: "状态" })
  if (!isDesktop.value) {
    return base.filter((c) => !["categories", "time", "memory", "rate", "status"].includes(c.accessorKey))
  }
  return base
})
</script>

<template>
  <!-- /problems/:id 和 /problems/new 等子路由由 NuxtPage 渲染 -->
  <NuxtPage v-if="route.path !== '/problems'" />
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

    <!-- 异步内容 -->
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : problems.length === 0 ? 'empty' : 'data'"
      error="题目加载失败"
      :empty-text="hasActiveFilters ? '没有找到符合条件的题目，试试其他筛选条件' : '暂无题目'"
      @retry="refresh"
    >
      <template #loading>
        <TableSkeleton :rows="8" :columns="['w-14', 'flex-1', 'w-16', 'w-24', 'w-16', 'w-16', 'w-20', 'w-16']" />
      </template>
      <template #empty-action v-if="hasActiveFilters">
        <UButton color="primary" variant="outline" class="px-4 py-1.5 text-xs" @click="router.push({ query: {} })">
          清除筛选
        </UButton>
      </template>

      <!-- 题目表格 -->
      <div class="bg-white border border-border rounded-xl overflow-x-auto">
        <UTable :columns="columns" :data="problems" :empty="'暂无题目'">
          <template #display_id-cell="{ row }">
            <ProblemId :display-id="row.original.display_id" :type="row.original.type" />
          </template>
          <template #title-cell="{ row }">
            <NuxtLink
              :to="`/problems/${row.original.id}`"
              class="text-text no-underline font-medium hover:text-primary"
            >
              {{ row.original.title }}
            </NuxtLink>
          </template>
          <template #difficulty-cell="{ row }">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeColors[row.original.difficulty] || ''">
              {{ difficultyLabel[row.original.difficulty] || row.original.difficulty }}
            </span>
          </template>
          <template #categories-cell="{ row }">
            <span
              v-for="cat in row.original.categories"
              :key="cat.id"
              class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 mr-1"
            >{{ cat.name }}</span>
            <span v-if="!row.original.categories?.length" class="text-xs text-text-muted">--</span>
          </template>
          <template #time-cell="{ row }">
            <span class="text-xs text-text-secondary">{{ row.original.runtime_config.evaluator.time_limit_ms }}ms</span>
          </template>
          <template #memory-cell="{ row }">
            <span class="text-xs text-text-secondary">{{ row.original.runtime_config.evaluator.memory_limit_mb }}MB</span>
          </template>
          <template #rate-cell="{ row }">
            <span class="text-xs text-text-secondary">{{ formatAcceptanceRate(row.original.acceptance_rate) }}</span>
          </template>
          <template #status-cell="{ row }">
            <StatusBadge :status="getProblemStatus(row.original.id)" />
          </template>
        </UTable>
      </div>

      <!-- 分页 -->
      <PaginationNav
        :current-page="page"
        :total-pages="totalPages"
        @page-change="setFilter('page', String($event))"
      />
    </AsyncContent>
  </div>
</template>
