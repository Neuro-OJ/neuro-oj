<script setup lang="ts">
import { useRoute } from "vue-router"
import { Clock, Server, Pencil, Code2, FileText, Lock, BookOpen } from "@lucide/vue"
import type { PostRow } from "~/composables/useCommunity"

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user } = useAuth()
const { config, loadConfig } = useCommunity()

const problemId = route.params.id as string

const { data, pending, error, refresh } = useFetch<{
  data: {
    id: string
    title: string
    description: string
    difficulty: string
    display_id: string
    type: string
    owner_id: string
    number: number
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId}`)

const problem = computed(() => data.value?.data ?? null)

const categories = computed(() => problem.value?.categories ?? [])

const canEdit = computed(() => {
  const p = problem.value
  if (!p) return false
  return user.value?.role === "admin" || (p.type === "U" && p.owner_id === user.value?.id)
})

const isDetailPage = computed(() => route.path === `/problems/${problemId}`)

function goToEditor() {
  router.push(`/editor/${problemId}`)
}

// ── 题解区（community-ui spec：题解列表 + 发布入口，服从模块开关与权限）──
const solutions = ref<PostRow[]>([])
const loadingSolutions = ref(false)
const eligibility = ref<{
  enabled: boolean
  requires_accepted: boolean
  accepted: boolean
  can_create: boolean
} | null>(null)

watch(
  problem,
  async (p) => {
    if (!p) return
    loadingSolutions.value = true
    try {
      const [solRes, cfg] = await Promise.all([
        $fetch<{ data: PostRow[] }>(
          `/api/v1/community/posts?type=solution&problem_id=${p.id}&limit=5`,
        ),
        loadConfig(),
      ])
      solutions.value = solRes.data
      if (isLoggedIn.value) {
        try {
          const el = await $fetch<{ data: typeof eligibility.value }>(
            `/api/v1/community/solutions/eligibility?problem_id=${p.id}`,
          )
          eligibility.value = el.data
        } catch {
          eligibility.value = null
        }
      } else {
        eligibility.value = null
      }
    } catch {
      // 模块关闭（403）或游客不可读（401）时题解区静默降级为空
      solutions.value = []
      eligibility.value = null
    } finally {
      loadingSolutions.value = false
    }
  },
  { immediate: true },
)

/** 发布入口禁用原因（未通过门槛 / 无权限 / 只读模式） */
const publishBlockReason = computed(() => {
  const el = eligibility.value
  if (!el) return null
  if (el.can_create) return null
  if (!el.enabled) return "题解区已关闭"
  if (config.value?.read_only) return "社区当前为只读模式"
  if (el.requires_accepted && !el.accepted) return "通过本题后可发布题解"
  return "当前账号没有发布题解的权限"
})
</script>

<template>
  <NuxtPage v-if="!isDetailPage" />

  <template v-else>
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : problem ? 'data' : 'empty'"
      error="题目加载失败"
      @retry="refresh"
    >
      <template #error>
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p>题目加载失败</p>
        <NuxtLink to="/problems" class="btn btn-outline">返回题目列表</NuxtLink>
      </template>

      <div class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- 题目信息卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-7 py-6 pb-5 border-b border-border">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
                >
                  {{ problem.display_id }}
                </span>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'"
                >
                  {{ problem.type === 'U' ? '用户题库' : '主题库' }}
                </span>
              </div>
              <h1 class="text-2xl font-bold mb-3 text-text">{{ problem.title }}</h1>
            </div>
            <NuxtLink
              v-if="canEdit"
              :to="`/problems/${problem.id}/edit`"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-text-secondary hover:text-primary hover:border-primary/40 transition-colors"
            >
              <Pencil :size="14" />
              编辑
            </NuxtLink>
          </div>
          <div class="flex items-center gap-5 flex-wrap">
            <DifficultyBadge :difficulty="problem.difficulty" />
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Clock :size="14" />
              {{ problem.runtime_config.evaluator.time_limit_ms }}ms
            </span>
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Server :size="14" />
              {{ problem.runtime_config.evaluator.memory_limit_mb }}MB
            </span>
          </div>
          <div v-if="categories.length" class="flex flex-wrap gap-1.5 mt-2.5">
            <span
              v-for="cat in categories"
              :key="cat.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
            >
              {{ cat.name }}
            </span>
          </div>
        </div>

        <div class="px-7 py-6">
          <MarkdownRenderer :content="problem.description" />
        </div>
      </div>

      <!-- 开始编码 CTA -->
      <div class="bg-white border border-border rounded-xl p-6 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-text mb-1">准备好开始编码了吗？</h2>
          <p class="text-sm text-text-secondary">
            点击下方按钮进入独立编码页面，享受沉浸式编辑器体验。
          </p>
        </div>
        <button
          class="btn btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
          @click="goToEditor"
        >
          <Code2 :size="16" />
          开始编码
        </button>
      </div>

      <div v-if="!isLoggedIn" class="text-center text-sm text-text-muted">
        <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
        后即可提交代码
      </div>
      <section class="rounded-xl border border-border bg-white p-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-text">题解与讨论</h2>
            <p class="mt-1 text-sm text-text-secondary">查看本题的公开题解，或在通过后分享思路。</p>
          </div>
          <div class="flex items-center gap-2">
            <!-- 发布入口：服从题解模块开关与当前用户权限（community-ui spec） -->
            <NuxtLink
              v-if="config?.solutions_enabled === false"
              :to="`/community?type=solution&problem_id=${problem.id}`"
              class="btn-outline text-sm"
            >
              查看题解
            </NuxtLink>
            <button
              v-else-if="!isLoggedIn"
              class="btn-primary text-sm"
              @click="router.push('/login')"
            >
              登录后发布题解
            </button>
            <NuxtLink
              v-else-if="eligibility?.can_create"
              :to="`/community?type=solution&problem_id=${problem.id}`"
              class="btn-primary text-sm"
            >
              <BookOpen :size="14" />
              发布题解
            </NuxtLink>
            <button
              v-else
              class="btn-primary text-sm opacity-60 cursor-not-allowed"
              :disabled="true"
              :title="publishBlockReason ?? '暂不可发布'"
            >
              发布题解
            </button>
            <NuxtLink :to="`/community?type=solution&problem_id=${problem.id}`" class="btn-outline text-sm">查看全部</NuxtLink>
          </div>
        </div>

        <!-- 题解列表（community-ui spec：题目详情页展示题解列表） -->
        <div v-if="loadingSolutions" class="mt-4 text-sm text-text-muted">题解加载中…</div>
        <div v-else-if="solutions.length === 0" class="mt-4 text-sm text-text-secondary">
          {{ config?.solutions_enabled === false ? "题解区已关闭。" : "暂无题解，来发布第一篇吧。" }}
        </div>
        <ul v-else class="mt-4 divide-y divide-border">
          <li v-for="item in solutions" :key="item.post.id" class="py-3 first:pt-0 last:pb-0">
            <NuxtLink
              :to="`/community/posts/${item.post.id}`"
              class="group flex items-start justify-between gap-3"
            >
              <span class="flex items-center gap-2 text-sm font-medium text-text group-hover:text-primary">
                <FileText :size="14" class="shrink-0 text-text-muted" />
                {{ item.post.title || "题解" }}
              </span>
              <span class="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
                <span v-if="item.post.is_locked" class="inline-flex items-center gap-0.5">
                  <Lock :size="11" />已锁定
                </span>
                <span>{{ item.author.username }}</span>
                <NuxtTime :datetime="item.post.created_at" relative locale="zh-CN" />
              </span>
            </NuxtLink>
          </li>
        </ul>

        <!-- 门槛禁用说明（community-ui spec 场景：未通过用户受门槛限制） -->
        <p v-if="isLoggedIn && eligibility && !eligibility.can_create && eligibility.enabled" class="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
          <Lock :size="12" />
          {{ publishBlockReason }}。通过本题后即可发布题解。
        </p>
      </section>
    </div>
    </AsyncContent>
  </template>
</template>
