<script setup lang="ts">
import {
  type CommunityCounts,
  type CommunityConfig,
  type PostRow,
  type PostType,
} from "~/composables/useCommunity"
import { useToast } from "~/composables/useToast"
import { useBanStatus } from "~/composables/useBanStatus"
import { stripMarkdown } from "~/utils/markdown"
import { extractApiError } from "~/utils/apiError"
import { publicUrl } from "~/utils/publicIdentifiers"
import { isCommunityEdited } from "~/utils/communityEdited"

const { isLoggedIn, user } = useAuth()
const route = useRoute()
const router = useRouter()
const { config, loadConfig } = useCommunity()
const { toast } = useToast()
const { dialog } = useDialog()
const { open: reportModal } = useReportModal()
const { api } = useApi()
const { userBanned } = useBanStatus()

// NOJ-317：SSR 阶段可能拿到游客权限（permissions 为空），登录用户水合后
// 需要强制刷新一次社区配置，否则“发布内容”按钮会一直处于灰色。
let configRefreshedForLogin = false
watch(
  [isLoggedIn, config],
  async ([loggedIn, cfg]) => {
    if (!loggedIn || !cfg || configRefreshedForLogin) return
    if (!cfg.permissions || Object.keys(cfg.permissions).length === 0) {
      configRefreshedForLogin = true
      await loadConfig(true)
    }
  },
  { immediate: true },
)

const ENABLED_TYPES: PostType[] = ["discussion", "solution", "moment"]
const typeFlag: Record<PostType, keyof CommunityConfig> = {
  discussion: "discussions_enabled",
  solution: "solutions_enabled",
  moment: "moments_enabled",
}
const typeLabel: Record<PostType, string> = {
  discussion: "讨论",
  solution: "题解",
  moment: "动态",
}

const activeType = ref<PostType>("discussion")

const posts = ref<PostRow[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const error = ref("")
const nextCursor = ref<string | null>(null)
const counts = ref<CommunityCounts | null>(null)

const searchKeyword = ref(typeof route.query.q === "string" ? route.query.q : "")
const searchProblemId = ref(
  typeof route.query.problem_id === "string" ? route.query.problem_id : "",
)
const isFiltering = computed(
  () => searchKeyword.value.trim() !== "" || searchProblemId.value.trim() !== "",
)

const showEditor = ref(false)
const previewMode = ref(false)
const title = ref("")
const content = ref("")
const boardId = ref("")
const boards = ref<{ id: string; name: string }[]>([])
const boardError = ref("")
const publishing = ref(false)
// 题解关联题目：problemId 为最终提交值，problemQuery 为搜索框显示文本
const problemId = ref(
  typeof route.query.problem_id === "string" ? route.query.problem_id : "",
)
const problemQuery = ref(problemId.value)
const problemResults = ref<{ id: string; display_id: string; title: string }[]>([])
const problemSearching = ref(false)
const showProblemDropdown = ref(false)
let problemSearchSeq = 0

const canCreateCurrentType = computed(() => {
  if (!config.value || config.value.read_only) return false
  const permission = activeType.value === "discussion"
    ? "discussion"
    : activeType.value === "solution"
    ? "solution"
    : "moment"
  return config.value.permissions[permission] === true
})

const canReport = computed(
  () => isLoggedIn.value && config.value?.permissions.report === true &&
    !userBanned.value,
)

const enabledTypes = computed<PostType[]>(() =>
  ENABLED_TYPES.filter((t) => config.value?.[typeFlag[t]] === true),
)

const postMaxLength = computed(() =>
  activeType.value === "moment"
    ? config.value?.moment_max_length ?? 500
    : config.value?.post_max_length ?? 20000,
)

function syncUrl() {
  const query: Record<string, string> = { type: activeType.value }
  if (searchKeyword.value.trim()) query.q = searchKeyword.value.trim()
  if (searchProblemId.value.trim()) query.problem_id = searchProblemId.value.trim()
  router.replace({ query })
}

async function loadPosts(reset = true, cursor?: string | null) {
  if (reset) {
    loading.value = true
    nextCursor.value = null
  } else {
    loadingMore.value = true
  }
  error.value = ""
  try {
    const result = await api.get<{ data: PostRow[]; next_cursor: string | null }>(
      "/api/v1/community/posts",
      {
        query: {
          type: activeType.value,
          problem_id: searchProblemId.value.trim() || undefined,
          q: searchKeyword.value.trim() || undefined,
          cursor: cursor ?? undefined,
        },
        silent: true,
      },
    )
    posts.value = reset ? result.data : [...posts.value, ...result.data]
    nextCursor.value = result.next_cursor ?? null
  } catch (err: unknown) {
    error.value = extractApiError(err).message
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !nextCursor.value) return
  await loadPosts(false, nextCursor.value)
}

async function loadCounts() {
  try {
    const result = await api.get<{ data: CommunityCounts }>(
      "/api/v1/community/posts/counts",
      { silent: true },
    )
    counts.value = result.data
  } catch {
    counts.value = null
  }
}

async function reportPost(item: PostRow) {
  if (!canReport.value) {
    toast.error("当前账号没有举报权限")
    return
  }
  const result = await reportModal()
  if (!result) return
  try {
    await api.post("/api/v1/community/reports", {
      post_id: item.post.id,
      category: result.category,
      reason: result.reason,
    })
    toast.success("举报已提交，感谢反馈")
  } catch (err: unknown) {
    // useApi 已弹后端错误（如重复举报）
  }
}

async function changeType(type: PostType) {
  if (type === activeType.value) return
  activeType.value = type
  showEditor.value = false
  previewMode.value = false
  syncUrl()
  await Promise.all([loadPosts(), loadCounts()])
}

async function applySearch() {
  syncUrl()
  await loadPosts()
}

async function clearSearch() {
  searchKeyword.value = ""
  searchProblemId.value = ""
  syncUrl()
  await loadPosts()
}

async function prepareEditor() {
  if (!isLoggedIn.value) return navigateTo("/login")
  if (!canCreateCurrentType.value) {
    toast.error("当前账号没有发布此类内容的权限")
    return
  }
  if (activeType.value === "discussion" && boards.value.length === 0) {
    try {
      const result = await api.get<{ data: { id: string; name: string }[] }>(
        "/api/v1/community/boards",
      )
      boards.value = result.data
      boardId.value = boards.value[0]?.id ?? ""
      boardError.value = ""
    } catch {
      return
    }
  }
  if (activeType.value === "discussion" && !boardId.value) {
    boardError.value = "暂无可用板块，无法发布讨论"
    toast.error("暂无可用板块，无法发布讨论")
    return
  }
  previewMode.value = false
  showEditor.value = true
}

async function searchProblems() {
  const q = problemQuery.value.trim()
  if (q.length < 2) {
    problemResults.value = []
    showProblemDropdown.value = false
    return
  }
  const seq = ++problemSearchSeq
  problemSearching.value = true
  try {
    const result = await api.get<{ data: { items: { id: string; display_id: string; title: string }[] } }>(
      "/api/v1/search",
      { query: { q, type: "problem" }, silent: true },
    )
    if (seq !== problemSearchSeq) return
    problemResults.value = result.data.items
    showProblemDropdown.value = true
  } catch {
    if (seq !== problemSearchSeq) return
    problemResults.value = []
    showProblemDropdown.value = false
  } finally {
    if (seq === problemSearchSeq) problemSearching.value = false
  }
}

function selectProblem(p: { id: string; display_id: string; title: string }) {
  problemId.value = p.id
  problemQuery.value = `${p.display_id} ${p.title}`
  showProblemDropdown.value = false
  problemResults.value = []
}

function clearProblemSelection() {
  problemId.value = ""
  problemQuery.value = ""
  showProblemDropdown.value = false
}

function searchProblemIdChanged() {
  if (problemQuery.value.trim().length >= 2) searchProblems()
}

function delayCloseProblemDropdown() {
  setTimeout(() => {
    showProblemDropdown.value = false
  }, 150)
}

async function publish() {
  if (publishing.value || !canCreateCurrentType.value) return
  publishing.value = true
  try {
    if (activeType.value === "discussion" && !boardId.value) {
      boardError.value = "请先选择板块"
      toast.error("请先选择板块")
      return
    }
    const body: Record<string, string> = { type: activeType.value, content: content.value }
    if (activeType.value !== "moment") body.title = title.value
    if (activeType.value === "discussion") body.board_id = boardId.value
    if (activeType.value === "solution") {
      const pid = problemId.value || problemQuery.value.trim()
      if (!pid) {
        toast.error("请选择或填写关联题目 ID")
        return
      }
      body.problem_id = pid
    }
    const result = await api.post<{ data: { status: string } }>(
      "/api/v1/community/posts",
      body,
    )
    toast.success(result.data.status === "pending" ? "内容已提交审核" : "发布成功")
    title.value = ""
    content.value = ""
    problemId.value = ""
    problemQuery.value = ""
    showEditor.value = false
    await Promise.all([loadPosts(), loadCounts()])
  } catch {
    // useApi 已弹后端错误；保留已输入内容供用户修改
  } finally {
    publishing.value = false
  }
}

async function init() {
  await loadConfig()
  // 默认 Tab 兜底：请求的类型未启用时回退到第一个启用的类型
  if (config.value?.enabled) {
    const requested = route.query.type as PostType | undefined
    const requestedEnabled = requested && ENABLED_TYPES.includes(requested)
      ? config.value[typeFlag[requested]] === true
      : false
    if (requestedEnabled) {
      activeType.value = requested as PostType
    } else {
      const fallback = ENABLED_TYPES.find((t) => config.value![typeFlag[t]] === true)
      if (fallback) activeType.value = fallback
    }
  }
  await Promise.all([loadPosts(), loadCounts()])
}

await init()
</script>

<template>
  <main class="mx-auto w-full max-w-4xl px-6 py-10">
    <div class="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold text-text">社区</h1>
        <p class="mt-2 text-text-secondary">在题解、讨论和动态中一起成长。</p>
      </div>
      <div class="flex items-center gap-2">
        <UButton color="primary" variant="outline" v-if="config?.enabled && isLoggedIn && config.bookmarks_enabled" to="/community/bookmarks"><UIcon name="i-lucide-bookmark" class="size-4" />我的收藏</UButton>
        <UButton color="primary" v-if="config?.enabled && isLoggedIn && !config.read_only"  :disabled="!canCreateCurrentType" :title="canCreateCurrentType ? '发布内容' : '当前账号没有发布此类内容的权限'" @click="prepareEditor"><UIcon name="i-lucide-plus" class="size-4" />发布内容</UButton>
      </div>
    </div>

    <div v-if="!config?.enabled" class="rounded-lg border border-border bg-white p-8 text-center text-text-secondary">社区功能暂未启用。</div>
    <div v-else-if="enabledTypes.length === 0" class="rounded-lg border border-border bg-white p-8 text-center text-text-secondary">所有内容模块均已关闭，暂无可用功能。</div>
    <template v-else>
      <div class="mb-6 flex gap-2 overflow-x-auto border-b border-border" role="tablist">
        <button
          v-for="t in enabledTypes"
          :key="t"
          type="button"
          role="tab"
          :aria-selected="activeType === t"
          class="flex items-center whitespace-nowrap rounded-t-md px-4 py-3 text-sm transition-colors hover:bg-primary-bg"
          :class="activeType === t ? 'border-b-2 border-primary font-semibold text-primary' : 'text-text-secondary'"
          @click="changeType(t)"
        >
          <UIcon :name="t === 'discussion' ? 'i-lucide-message-square' : t === 'solution' ? 'i-lucide-lightbulb' : 'i-lucide-pen-line'" class="mr-1 inline-flex size-4" />
          {{ typeLabel[t] }}
          <span v-if="counts && counts[t] > 0" class="ml-1 rounded-full bg-primary-bg px-1.5 py-0.5 text-xs text-primary">{{ counts[t] }}</span>
        </button>
      </div>

      <form class="mb-6 flex flex-wrap gap-3 rounded-lg border border-border bg-white p-4 shadow-card" @submit.prevent="applySearch">
        <label class="min-w-52 flex-1"><span class="mb-1 block text-xs text-text-secondary">标题或正文</span><div class="relative"><UIcon name="i-lucide-search" class="absolute left-3 top-2.5 text-text-secondary size-4" /><input v-model="searchKeyword" class="w-full rounded border border-border py-2 pl-9 pr-3 text-sm" placeholder="搜索帖子标题或正文"></div></label>
        <label class="min-w-44 flex-1"><span class="mb-1 block text-xs text-text-secondary">关联题目 ID</span><input v-model="searchProblemId" class="w-full rounded border border-border px-3 py-2 text-sm" placeholder="例如 1001"></label>
        <div class="flex items-end gap-2"><UButton color="primary" type="submit"><UIcon name="i-lucide-search" class="size-4" />搜索</UButton><UButton color="primary" variant="outline" v-if="isFiltering"  type="button" @click="clearSearch">清除</UButton></div>
      </form>

      <form v-if="showEditor" class="mb-6 rounded-lg border border-border bg-white p-5 shadow-card" @submit.prevent="publish">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 class="font-semibold">发布{{ typeLabel[activeType] }}</h2>
          <UButton color="neutral" variant="outline" size="sm" class="border-border py-1 text-text-secondary hover:bg-primary-bg" type="button"  @click="previewMode = !previewMode">
            <UIcon name="i-lucide-eye" class="size-3.5" v-if="!previewMode"/>
            <UIcon name="i-lucide-edit-3" class="size-3.5" v-else/>
            {{ previewMode ? "编辑" : "预览" }}
          </UButton>
        </div>
        <input v-if="activeType !== 'moment'" v-model="title" class="mb-3 w-full rounded border border-border px-3 py-2" :placeholder="activeType === 'solution' ? '题解标题' : '讨论标题'" required>
        <div v-if="activeType === 'solution'" class="relative mb-3">
          <input v-model="problemQuery" class="w-full rounded border border-border px-3 py-2" placeholder="搜索题目（输入至少 2 个字符）或直接填题目 ID" @focus="searchProblemIdChanged" @input="searchProblems" @blur="delayCloseProblemDropdown">
          <span v-if="problemQuery" class="absolute right-2 top-2 cursor-pointer text-xs text-text-secondary hover:text-primary" @mousedown.prevent="clearProblemSelection">清除</span>
          <ul v-if="showProblemDropdown" class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded border border-border bg-white shadow-modal">
            <li v-if="problemSearching" class="px-3 py-2 text-xs text-text-secondary">搜索中…</li>
            <li v-for="p in problemResults" :key="p.id" class="cursor-pointer px-3 py-2 text-sm hover:bg-primary-bg" @mousedown.prevent="selectProblem(p)">{{ p.display_id }} · {{ p.title }}</li>
            <li v-if="!problemSearching && problemResults.length === 0" class="px-3 py-2 text-xs text-text-secondary">无匹配题目</li>
          </ul>
          <p class="mt-1 text-xs text-text-muted">当前关联题目：{{ problemQuery || '未选择' }}（可手动输入题目 ID）</p>
        </div>
        <USelect v-if="activeType === 'discussion'" v-model="boardId" :items="boards.map((b) => ({ label: b.name, value: b.id }))" class="mb-3 w-full" :placeholder="boards.length ? '选择板块' : '暂无可用板块'" />
        <p v-if="boardError" class="mb-3 text-xs text-red-600">{{ boardError }}</p>
        <template v-if="!previewMode">
          <textarea v-model="content" class="min-h-36 w-full rounded border border-border px-3 py-2" :placeholder="`支持 Markdown、代码和公式（最长 ${postMaxLength} 字符）`" required />
        </template>
        <template v-else>
          <div class="min-h-36 rounded border border-border px-3 py-2">
            <MarkdownRenderer v-if="content.trim()" :content="content" />
            <p v-else class="text-sm text-text-muted">暂无内容</p>
          </div>
        </template>
        <div class="mt-3 flex items-center justify-between gap-2">
          <p class="text-xs text-text-muted">{{ content.length }} / {{ postMaxLength }}</p>
          <div class="flex gap-2"><UButton color="primary" variant="outline" type="button"  :disabled="publishing" @click="showEditor = false">取消</UButton><UButton color="primary" type="submit" :disabled="publishing || !content.trim() || content.length > postMaxLength">{{ publishing ? '发布中…' : '发布' }}</UButton></div>
        </div>
      </form>

      <p v-if="error" class="rounded border border-red-200 bg-red-50 p-4 text-red-700">{{ error }}</p>
      <div v-else-if="loading" class="py-12 text-center text-text-secondary">加载中…</div>
      <div v-else-if="posts.length === 0" class="rounded-lg border border-dashed border-border p-10 text-center text-text-secondary">
        <p>{{ isFiltering ? '没有匹配的帖子。' : '还没有内容，来发布第一篇吧。' }}</p>
        <UButton color="primary" variant="outline" class="mt-4" v-if="isFiltering"  type="button" @click="clearSearch">清除筛选</UButton>
      </div>
      <div v-else class="space-y-4">
        <article v-for="item in posts" :key="item.post.id" class="rounded-lg border border-border bg-white p-5 shadow-card">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="rounded bg-primary-bg px-2 py-0.5 text-xs text-primary">{{ typeLabel[item.post.type] }}</span>
            <span v-if="item.post.status === 'pending'" class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">审核中</span>
            <span v-if="item.post.status === 'hidden'" class="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">已隐藏</span>
            <span v-if="item.post.is_locked" class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"><UIcon name="i-lucide-lock" class="size-[10px]" />已锁定</span>
          </div>
          <NuxtLink :to="publicUrl('post', item.post.public_id || item.post.id)" class="block no-underline">
            <h2 v-if="item.post.title" class="text-lg font-semibold text-text hover:text-primary">{{ item.post.title }}</h2>
            <p class="mt-2 line-clamp-3 text-sm leading-6 text-text-secondary">{{ stripMarkdown(item.post.content) }}</p>
          </NuxtLink>
          <div class="mt-4 flex items-center gap-4 text-xs text-text-secondary">
            <UserIdentity :user="item.author" size="sm" />
            <NuxtTime :datetime="item.post.created_at" relative locale="zh-CN" />
            <span v-if="isCommunityEdited(item.post.created_at, item.post.updated_at)" class="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-text-secondary"><UIcon name="i-lucide-pencil" class="size-[10px]" />已编辑</span>
            <span aria-label="点赞数" class="inline-flex items-center"><UIcon name="i-lucide-heart" class="mr-1 size-3.5" />{{ item.likes }}</span>
            <span aria-label="评论数" class="inline-flex items-center"><UIcon name="i-lucide-message-square" class="mr-1 size-3.5" />{{ item.comments }}</span>
            <UButton color="neutral" variant="ghost" size="xs" class="ml-auto" v-if="canReport && user?.id !== item.post.author_id" type="button" @click="reportPost(item)"><UIcon name="i-lucide-flag" class="size-3.5" />举报</UButton>
          </div>
        </article>
        <div v-if="nextCursor" class="text-center">
          <UButton color="primary" variant="outline" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中…' : '加载更多' }}</UButton>
        </div>
      </div>
    </template>
  </main>
</template>

