<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { problemUrl } from "~/utils/publicIdentifiers"
import { difficultyBadgeColors, difficultyLabels } from "~/utils/submissionFormat"

definePageMeta({
  middleware: "auth",
})

const { isLoggedIn, loading, user } = useAuth()
const router = useRouter()
const { api } = useApi()
const { dialog } = useDialog()

useRequireLogin()

interface ProblemItem {
  id: string
  title: string
  difficulty: string
  display_id: string
  number: number
  owner_id: string
  type: string
  is_objective: boolean
  runtime_config?: { evaluator?: { time_limit_ms?: number; memory_limit_mb?: number } } | null
  tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[]
  created_at: string
}

const problems = ref<ProblemItem[]>([])
const pageLoading = ref(true)
const loadError = ref("")
const totalPages = ref(1)
const perPage = 20

// ── 搜索栏（仿题库：URL 查询参数驱动；无类型筛选，本页固定 U 型本人） ──
const route = useRoute()
// 从 URL 查询参数读取筛选值（单一来源，与题库页一致）
const keyword = computed(() => (route.query.keyword as string) || "")
const difficulty = computed(() => (route.query.difficulty as string) || "")
const tagId = computed(() => (route.query.tag as string) || "")
const page = computed(() => Number(route.query.page) || 1)
const tagOptions = ref<{ id: string; name: string; kind: 'problem' | 'algorithm' }[]>([])

async function loadTagOptions() {
  try {
    const res = await api.get<{ data: { id: string; name: string; kind: 'problem' | 'algorithm' }[] }>(
      "/api/v1/tags",
      { silent: true },
    )
    tagOptions.value = res.data ?? []
  } catch {
    tagOptions.value = []
  }
}

/** 更新单个筛选参数并写入 URL（题库页同款逻辑）；非 page 参数自动重置到第 1 页 */
function setFilter(key: string, value: string) {
  const query: Record<string, string> = { ...(route.query as Record<string, string>) }
  if (value) query[key] = value
  else delete query[key]
  if (key !== 'page') delete query.page
  router.push({ query })
}

// 搜索框本地输入态（300ms debounce 后写 URL，与题库页 ProblemFilterBar 一致）
const searchInput = ref(keyword.value)
let keywordTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (val) => {
  clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => setFilter('keyword', val.trim()), 300)
})
watch(keyword, (val) => {
  if (val !== searchInput.value) {
    clearTimeout(keywordTimer)
    searchInput.value = val
  }
})
onUnmounted(() => clearTimeout(keywordTimer))

function selectDifficulty(value: string) {
  setFilter('difficulty', value === difficulty.value ? '' : value)
}

function selectTag(value: string | null) {
  // 点击已选中的标签 → 清除筛选（回到全部）
  setFilter('tag', value === tagId.value ? '' : value || '')
}

async function loadProblems() {
  if (!isLoggedIn.value || !user.value) return
  pageLoading.value = true
  loadError.value = ""
  try {
    const params = new URLSearchParams({
      type: "U",
      owner_id: user.value.id,
      page: String(page.value),
      limit: String(perPage),
    })
    if (keyword.value.trim()) params.set("keyword", keyword.value.trim())
    if (difficulty.value) params.set("difficulty", difficulty.value)
    if (tagId.value) params.set("tag", tagId.value)
    const res = await api.get<{ data: ProblemItem[]; total: number }>(
      `/api/v1/problems?${params.toString()}`,
      { silent: true },
    )
    // 后端已按 type=U + owner_id 过滤，直接使用分页结果
    problems.value = res.data
    totalPages.value = Math.ceil(res.total / perPage)
  } catch (err: unknown) {
    loadError.value = extractApiError(err).message
  } finally {
    pageLoading.value = false
  }
}

// URL 筛选参数变化时重新加载（keyword/difficulty/tag/page 任一变化）
watch([keyword, difficulty, tagId, page], loadProblems)

// 登录就绪后加载一次（onMounted 时 user 可能尚未就绪）
watch(isLoggedIn, (val) => {
  if (val) loadProblems()
})

onMounted(() => {
  loadProblems()
  loadTagOptions()
})

// 删除题目（含客观题套卷，级联清理小题/提交/支持包等）
const deletingId = ref<string | null>(null)
async function onDeleteProblem(problem: ProblemItem) {
  const ok = await dialog.confirm(`确定删除题目「${problem.title}」？其下全部提交记录将一并删除。`, {
    title: "删除题目",
    danger: true,
    confirmText: "删除",
  })
  if (!ok) return
  deletingId.value = problem.id
  try {
    await api.delete(`/api/v1/problems/${problem.display_id}`)
    await loadProblems()
  } catch {
    // useApi 已弹错误
  } finally {
    deletingId.value = null
  }
}

// 仿题库页面的列定义
const columns = [
  { accessorKey: "display_id", header: "#" },
  { accessorKey: "title", header: "题目" },
  { accessorKey: "difficulty", header: "难度" },
  { accessorKey: "tags", header: "标签" },
  { accessorKey: "created_at", header: "创建时间" },
  { accessorKey: "actions", header: "操作" },
]
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-text">我的题目</h1>
        <span class="text-sm text-text-muted">{{ problems.length }} 道用户题</span>
      </div>
      <NuxtLink to="/problems/new" class="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
        创建题目
      </NuxtLink>
    </div>

    <!-- 搜索栏（仿题库，去掉类型筛选；本页固定 U 型本人） -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 mb-5">
      <div class="relative flex-1 max-w-sm">
        <input
          v-model="searchInput"
          type="text"
          placeholder="搜索题目..."
          aria-label="按标题或题号搜索"
          class="w-full px-3 py-2 pr-8 text-sm border border-border rounded-lg bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors duration-150"
        />
        <button
          v-if="searchInput"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
          aria-label="清除搜索"
          @click="searchInput = ''"
        >
          <span class="text-sm leading-none">&times;</span>
        </button>
      </div>

      <!-- 难度筛选 -->
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs text-text-muted mr-1">难度:</span>
        <button
          v-for="d in [{ value: '', label: '全部' }, { value: 'easy', label: '简单' }, { value: 'medium', label: '中等' }, { value: 'hard', label: '困难' }]"
          :key="d.value"
          role="radio"
          :aria-checked="difficulty === d.value"
          class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors duration-150"
          :class="difficulty === d.value ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:border-primary/40'"
          @click="selectDifficulty(d.value)"
        >
          {{ d.label }}
        </button>
      </div>

      <!-- 标签筛选 -->
      <div v-if="tagOptions.length > 0" class="flex items-center gap-1.5">
        <span class="text-xs text-text-muted mr-1">标签:</span>
        <USelect
          :model-value="tagId"
          :items="tagOptions
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ label: t.name, value: t.id }))"
          size="xs"
          class="min-w-[150px]"
          placeholder="全部标签"
          aria-label="按标签筛选"
          @update:model-value="selectTag"
        />
      </div>
    </div>

    <AsyncContent
      :status="pageLoading ? 'loading' : loadError ? 'error' : problems.length === 0 ? 'empty' : 'data'"
      :error="loadError || undefined"
      empty-text="你还没有创建任何题目"
      @retry="loadProblems"
    >
      <template #error>
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p>{{ loadError }}</p>
        <UButton color="primary" variant="outline" size="sm" @click="loadProblems">重试</UButton>
      </template>

      <template #empty>
        <p>你还没有创建任何题目</p>
        <NuxtLink to="/problems/new" class="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
          创建第一道题
        </NuxtLink>
      </template>

      <!-- 题目表格（仿题库页面样式） -->
      <div class="bg-white border border-border rounded-xl overflow-x-auto">
        <UTable :columns="columns" :data="problems" :empty="'暂无题目'">
          <template #display_id-cell="{ row }">
            <ProblemId :display-id="row.original.display_id" :type="row.original.type" />
          </template>
          <template #title-cell="{ row }">
            <NuxtLink
              :to="problemUrl(row.original.id, row.original.display_id)"
              class="text-text no-underline font-medium hover:text-primary"
            >
              {{ row.original.title }}
            </NuxtLink>
          </template>
          <template #difficulty-cell="{ row }">
            <!-- 客观题：在难度位置标记为「客观题」 -->
            <span
              v-if="row.original.is_objective"
              class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700"
            >
              客观题
            </span>
            <span
              v-else
              class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
              :class="difficultyBadgeColors[row.original.difficulty] || ''"
            >
              {{ difficultyLabels[row.original.difficulty] || row.original.difficulty }}
            </span>
          </template>
          <template #tags-cell="{ row }">
            <span
              v-for="tag in row.original.tags"
              :key="tag.id"
              class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 mr-1"
            >{{ tag.name }}</span>
            <span v-if="!row.original.tags?.length" class="text-xs text-text-muted">--</span>
          </template>
          <template #created_at-cell="{ row }">
            <span class="text-xs text-text-secondary">{{ new Date(row.original.created_at).toLocaleDateString("zh-CN") }}</span>
          </template>
          <template #actions-cell="{ row }">
            <div class="inline-flex items-center gap-1.5">
              <NuxtLink
                :to="`/problems/${row.original.display_id}/edit`"
                class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-border rounded-md text-text-secondary hover:text-primary hover:border-primary/40 transition-colors"
              >
                编辑
              </NuxtLink>
              <button
                type="button"
                :disabled="deletingId === row.original.id"
                class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-border rounded-md text-red-600 bg-none cursor-pointer hover:text-red-700 hover:border-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                @click="onDeleteProblem(row.original)"
              >
                <UIcon v-if="deletingId === row.original.id" name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
                {{ deletingId === row.original.id ? "删除中…" : "删除" }}
              </button>
            </div>
          </template>
        </UTable>
      </div>
    </AsyncContent>
  </div>
</template>
