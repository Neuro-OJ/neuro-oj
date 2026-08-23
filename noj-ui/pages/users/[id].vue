<script setup lang="ts">
import { useRoute } from "vue-router"
import { useMessages } from "~/composables/useMessages"
import { useToast } from "~/composables/useToast"
import { difficultyBadgeColors, difficultyLabels, formatDateTime, formatScore, getLanguageLabel } from "~/utils/submissionFormat"
import { buildMonthCalendar } from "~/utils/checkinCalendar"

const route = useRoute()
const router = useRouter()
const { user: currentUser } = useAuth()
const { findOrCreateConversation } = useMessages()
const { toast } = useToast()
const { api } = useApi()

const userId = route.params.id as string

interface UserProfile {
  user: {
    id: string
    username: string
    bio: string
    created_at: string
  }
  stats: {
    total_submissions: number
    accepted: number
    acceptance_rate: number
    solved_count: number
  }
  /** 全站排名（issue user-ranking）；未上榜时为 null */
  rank: number | null
  solved_problems: {
    id: string
    title: string
    difficulty: string
    accepted_at: string
  }[]
  recent_submissions: {
    id: string
    problem_id: string
    problem_title: string
    language: string
    status: string
    result_status: string | null
    score: number | null
    created_at: string
  }[]
  community_stats: { following_count: number; follower_count: number; solution_count: number; moment_count: number }
  solutions: { id: string; title: string; created_at: string }[]
  moments: { id: string; content: string; created_at: string }[]
}

interface ProfileResponse {
  data: UserProfile
}

const { data, pending, error, refresh } = useFetch<ProfileResponse>(
  `/api/v1/users/${userId}/profile`,
)

const profile = computed(() => data.value?.data ?? null)

interface CheckinStatsData {
  total_days: number
  current_streak: number
  max_streak: number
  month_days: number
  last_checkin_date: string | null
}

interface CheckinHistoryData {
  days: string[]
  total_days: number
}

// 活跃度（issue #184）：stats/history 支持 user_id 参数公开查询
const {
  data: checkinStats,
  error: checkinError,
  pending: checkinPending,
  refresh: refreshCheckinStats,
} = useFetch<{ data: CheckinStatsData }>(
  `/api/v1/checkin/stats?user_id=${userId}`,
)
const {
  data: checkinHistory,
  error: checkinHistoryError,
  pending: checkinHistoryPending,
  refresh: refreshCheckinHistory,
} = useFetch<{ data: CheckinHistoryData }>(
  `/api/v1/checkin/history?days=30&user_id=${userId}`,
)

const checkinLoading = computed(() => checkinPending.value || checkinHistoryPending.value)
const checkinFailed = computed(() => !!checkinError.value || !!checkinHistoryError.value)

async function retryCheckin() {
  await Promise.all([refreshCheckinStats(), refreshCheckinHistory()])
}

// 本月 UTC 日历：已签到日期高亮，今日描边
const monthCalendar = computed(() =>
  buildMonthCalendar(
    checkinHistory.value?.data?.days ?? [],
    new Date().toISOString().slice(0, 10),
  ),
)

const following = ref(false)

// 该用户创建的 U 型题目
interface CreatedProblem {
  id: string
  title: string
  difficulty: string
  display_id: string
  created_at: string
}

const { data: createdData, pending: createdPending } = useFetch<{
  data: CreatedProblem[]
}>(
  `/api/v1/problems?type=U&owner_id=${userId}&limit=50`,
)

const createdProblems = computed(() => createdData.value?.data ?? [])

interface TrainingProfile {
  id: string
  title: string
  description: string
  visibility: 'private' | 'unlisted' | 'public'
  is_pinned: boolean
  created_by: string
  created_at: string
  updated_at: string
  problem_count: number
}

const { data: trainingsData } = useFetch<{ data: TrainingProfile[]; total: number }>(
  `/api/v1/trainings?created_by=${userId}`,
  { query: { page: 1, per_page: 100 }, silent: true },
)
const profileTrainings = computed(() => trainingsData.value?.data ?? [])

// 当前登录用户是否在查看自己的主页
const isOwnProfile = computed(
  () => currentUser.value?.id === userId,
)

// 语言标签（统一走 utils/submissionFormat 的 getLanguageLabel）

// 结果状态
const resultBadgeColors: Record<string, string> = {
  Accepted: "bg-green-100 text-green-700",
  WrongAnswer: "bg-red-100 text-red-800",
  TimeLimitExceeded: "bg-orange-100 text-orange-800",
  MemoryLimitExceeded: "bg-orange-100 text-orange-800",
  RuntimeError: "bg-red-100 text-red-800",
  SystemError: "bg-red-100 text-red-800",
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
}

async function startConversation() {
  await findOrCreateConversation(userId)
  router.push(`/messages`)
}

async function toggleFollow() {
  const result = await api.post<{ data: { following: boolean } }>(`/api/v1/community/users/${userId}/follow`)
  following.value = result.data.following
  toast.success(following.value ? "已关注" : "已取消关注")
}

</script>

<template>
  <div class="max-w-[900px] mx-auto px-4 py-6 sm:px-6 sm:py-8 flex flex-col gap-6">
    <!-- 异步内容 -->
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : profile ? 'data' : 'empty'"
      error="用户不存在"
      @retry="refresh"
    >
      <template #error>
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p>用户不存在</p>
      </template>

      <template v-if="profile">
      <!-- 用户信息卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-6 sm:px-8 sm:py-8">
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-5">
              <!-- 头像 -->
              <UserIdentity :user="profile.user" :show-username="false" size="lg" />
              <div class="flex flex-col gap-1.5">
                <h1 class="text-2xl font-bold text-text">{{ profile.user.username }}</h1>
                <div class="flex items-center gap-2 text-sm text-text-muted">
                  <UIcon name="i-lucide-calendar" class="size-3.5" />
                  <span>{{ formatDate(profile.user.created_at) }} 注册</span>
                </div>
              </div>
            </div>
            <!-- 编辑个人资料按钮（仅自己可见） -->
            <UButton color="primary" variant="outline" class="text-xs px-3 py-1.5" v-if="isOwnProfile"
              to="/settings">
              编辑个人资料
            </UButton>
            <!-- 发送私信按钮（查看他人主页时显示，与关注按钮并列） -->
            <UButton color="primary" variant="outline" class="text-xs px-3 py-1.5 flex items-center gap-1.5" v-else-if="currentUser"
              @click="startConversation">
              <UIcon name="i-lucide-send" class="size-3.5" />
              发送私信
            </UButton>
            <!-- 关注按钮：独立 v-if（需与私信按钮同时显示） -->
            <UButton color="primary" variant="outline" class="text-xs px-3 py-1.5" v-if="currentUser && !isOwnProfile" @click="toggleFollow">{{ following ? '已关注' : '关注' }}</UButton>
          </div>

          <!-- Bio（Markdown 渲染） -->
          <div v-if="profile.user.bio" class="mt-5 pt-5 border-t border-border">
            <MarkdownRenderer :content="profile.user.bio" />
          </div>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">总提交</span>
          <span class="text-2xl font-bold text-text">{{ profile.stats.total_submissions }}</span>
        </div>
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">通过</span>
          <span class="text-2xl font-bold text-green-600">{{ profile.stats.accepted }}</span>
        </div>
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">通过率</span>
          <span class="text-2xl font-bold text-text">
            {{ (profile.stats.acceptance_rate * 100).toFixed(1) }}%
          </span>
        </div>
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">解题数</span>
          <span class="text-2xl font-bold text-primary">{{ profile.stats.solved_count }}</span>
        </div>
        <!-- 全站排名（仅上榜用户显示） -->
        <div
          v-if="profile.rank !== null"
          class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1"
        >
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">全站排名</span>
          <NuxtLink
            to="/ranking"
            class="text-2xl font-bold text-text no-underline hover:text-primary tabular-nums"
          >
            #{{ profile.rank }}
          </NuxtLink>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div class="rounded-xl border border-border bg-white px-5 py-4"><span class="text-xs text-text-muted">关注</span><p class="mt-1 text-xl font-bold text-text">{{ profile.community_stats.following_count }}</p></div>
        <div class="rounded-xl border border-border bg-white px-5 py-4"><span class="text-xs text-text-muted">粉丝</span><p class="mt-1 text-xl font-bold text-text">{{ profile.community_stats.follower_count }}</p></div>
        <div class="rounded-xl border border-border bg-white px-5 py-4"><span class="text-xs text-text-muted">题解</span><p class="mt-1 text-xl font-bold text-text">{{ profile.community_stats.solution_count }}</p></div>
        <div class="rounded-xl border border-border bg-white px-5 py-4"><span class="text-xs text-text-muted">动态</span><p class="mt-1 text-xl font-bold text-text">{{ profile.community_stats.moment_count }}</p></div>
      </div>

      <!-- 活跃度（issue #184）：连续天数 + 累计 + 本月签到日历 -->
      <section class="rounded-xl border border-border bg-white p-6">
        <h2 class="text-base font-semibold text-text">活跃度</h2>

        <div v-if="checkinLoading" class="mt-3 text-sm text-text-muted">加载中...</div>

        <div v-else-if="checkinFailed" class="mt-3 flex items-center justify-between gap-3">
          <span class="text-sm text-text-secondary">活跃度加载失败</span>
          <UButton size="xs" color="primary" variant="outline" @click="retryCheckin">
            <UIcon name="i-lucide-rotate-cw" class="size-3.5" />重试
          </UButton>
        </div>

        <div v-else-if="!checkinStats" class="mt-3 text-sm text-text-muted">
          暂无签到数据
        </div>

        <template v-else>
          <div class="mt-3 grid grid-cols-3 gap-3">
            <div class="rounded-lg bg-bg-page px-4 py-3 text-center"><span class="block text-xs text-text-muted">当前连续</span><p class="mt-1 text-xl font-bold text-primary">{{ checkinStats.current_streak }}<span class="text-xs font-normal text-text-muted"> 天</span></p></div>
            <div class="rounded-lg bg-bg-page px-4 py-3 text-center"><span class="block text-xs text-text-muted">累计签到</span><p class="mt-1 text-xl font-bold text-text">{{ checkinStats.total_days }}<span class="text-xs font-normal text-text-muted"> 天</span></p></div>
            <div class="rounded-lg bg-bg-page px-4 py-3 text-center"><span class="block text-xs text-text-muted">本月签到</span><p class="mt-1 text-xl font-bold text-text">{{ checkinStats.month_days }}<span class="text-xs font-normal text-text-muted"> 天</span></p></div>
          </div>
          <div class="mt-4">
            <div class="mb-2 flex items-center justify-between text-xs text-text-muted"><span>本月签到日历（UTC）</span><span class="font-medium text-primary">最长连续 {{ checkinStats.max_streak }} 天</span></div>
            <div class="grid grid-cols-7 gap-1.5">
              <div v-for="cell in monthCalendar" :key="cell.date" class="flex aspect-square items-center justify-center rounded-md text-xs" :class="cell.checked ? 'bg-primary font-semibold text-white' : cell.isToday ? 'border border-primary text-primary' : 'bg-bg-page text-text-muted'">{{ cell.day }}</div>
            </div>
          </div>
        </template>
      </section>

      <section v-if="profile.solutions.length || profile.moments.length" class="rounded-xl border border-border bg-white p-6"><h2 class="text-base font-semibold text-text">社区内容</h2><div class="mt-3 space-y-2"><NuxtLink v-for="solution in profile.solutions" :key="solution.id" :to="`/community/posts/${solution.id}`" class="block text-sm text-primary no-underline hover:underline">题解 · {{ solution.title }}</NuxtLink><NuxtLink v-for="moment in profile.moments" :key="moment.id" :to="`/community/posts/${moment.id}`" class="block line-clamp-1 text-sm text-primary no-underline hover:underline">动态 · {{ moment.content }}</NuxtLink></div></section>

      <!-- 已通过题目 -->
      <div v-if="profile.solved_problems.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-bg-page">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-check-circle" class="text-green-600 size-4.5" />
            已通过题目
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="problem in profile.solved_problems"
            :key="problem.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-primary-bg"
          >
            <NuxtLink
              :to="`/problems/${problem.id}`"
              class="text-sm text-primary no-underline hover:underline"
            >
              {{ problem.title }}
            </NuxtLink>
            <div class="flex items-center gap-3">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                :class="difficultyBadgeColors[problem.difficulty] || ''"
              >
                {{ difficultyLabels[problem.difficulty] || problem.difficulty }}
              </span>
              <span class="text-xs text-text-muted">{{ formatDate(problem.accepted_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 创建的题目 -->
      <div v-if="createdProblems.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-bg-page">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-file-text" class="text-primary size-4.5" />
            创建的题目
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="problem in createdProblems"
            :key="problem.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-primary-bg"
          >
            <div class="flex items-center gap-3">
              <ProblemId :display-id="problem.display_id" :type="'U'" />
              <NuxtLink
                :to="`/problems/${problem.id}`"
                class="text-sm text-primary no-underline hover:underline"
              >
                {{ problem.title }}
              </NuxtLink>
            </div>
            <div class="flex items-center gap-3">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                :class="difficultyBadgeColors[problem.difficulty] || ''"
              >
                {{ difficultyLabels[problem.difficulty] || problem.difficulty }}
              </span>
              <span class="text-xs text-text-muted">{{ formatDate(problem.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 我的题单 -->
      <div v-if="profileTrainings.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-bg-page">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-list-todo" class="text-primary size-4.5" />
            我的题单
          </h2>
        </div>
        <div class="divide-y divide-border">
          <NuxtLink
            v-for="training in profileTrainings"
            :key="training.id"
            :to="`/trainings/${training.id}`"
            class="flex items-center justify-between px-6 py-3 hover:bg-primary-bg no-underline"
          >
            <span class="text-sm text-primary">{{ training.title }}</span>
            <span class="text-xs text-text-muted">{{ training.problem_count }} 题</span>
          </NuxtLink>
        </div>
      </div>

      <!-- 最近提交 -->
      <div v-if="profile.recent_submissions.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-bg-page">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-clock" class="text-text-secondary size-4.5" />
            最近提交
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="sub in profile.recent_submissions"
            :key="sub.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-primary-bg"
          >
            <div class="flex items-center gap-3 min-w-0">
              <NuxtLink
                :to="`/submissions/${sub.id}`"
                class="text-sm text-primary no-underline hover:underline truncate"
              >
                {{ sub.problem_title || sub.problem_id }}
              </NuxtLink>
              <span class="text-xs text-text-muted whitespace-nowrap shrink-0">
                {{ getLanguageLabel(sub.language) }}
              </span>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <span
                v-if="sub.result_status"
                class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                :class="resultBadgeColors[sub.result_status] || 'bg-gray-100 text-gray-700'"
              >
                {{ sub.result_status }}
              </span>
              <span v-else class="text-xs text-text-muted">等待评测</span>
              <span class="text-xs text-text-muted">{{ formatDateTime(sub.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
    </AsyncContent>
  </div>
</template>
