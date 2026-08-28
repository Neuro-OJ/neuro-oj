<script setup lang="ts">
import { useRoute } from "vue-router"
import { useMessages } from "~/composables/useMessages"
import { useToast } from "~/composables/useToast"
import { difficultyBadgeColors, difficultyLabels, formatDateTime, formatScore, getLanguageLabel } from "~/utils/submissionFormat"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"

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
    display_id?: string
    title: string
    difficulty: string
    accepted_at: string
  }[]
  recent_submissions: {
    id: string
    public_id?: string
    problem_id: string
    problem_title: string
    language: string
    status: string
    result_status: string | null
    score: number | null
    created_at: string
  }[]
  community_stats: { following_count: number; follower_count: number; solution_count: number; moment_count: number }
  solutions: { id: string; public_id?: string; title: string; created_at: string }[]
  moments: { id: string; public_id?: string; content: string; created_at: string }[]
}

interface ProfileResponse {
  data: UserProfile
}

const { data, pending, error, refresh } = useFetch<ProfileResponse>(
  `/api/v1/users/${userId}/profile`,
)

const profile = computed(() => data.value?.data ?? null)

useSeoMeta({
  title: () => profile.value?.user?.username ? `${profile.value.user.username} - Neuro OJ` : '用户 - Neuro OJ',
  description: () => profile.value?.user?.bio ? profile.value.user.bio.slice(0, 160) : 'Neuro OJ 用户主页',
  ogTitle: () => profile.value?.user?.username ?? 'Neuro OJ',
  ogDescription: () => profile.value?.user?.bio ? profile.value.user.bio.slice(0, 160) : 'Neuro OJ 用户主页',
})

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
  `/api/v1/checkin/history?days=365&user_id=${userId}`,
)

const checkinLoading = computed(() => checkinPending.value || checkinHistoryPending.value)
const checkinFailed = computed(() => !!checkinError.value || !!checkinHistoryError.value)
// useFetch 返回 { data: CheckinStatsData }，解包出统计对象
const checkinStatsData = computed(() => checkinStats.value?.data ?? null)

async function retryCheckin() {
  todayStr.value = new Date().toISOString().slice(0, 10)
  await Promise.all([refreshCheckinStats(), refreshCheckinHistory()])
}

// GitHub 风格贡献图：起始日固定为一年前，保证至少展示一整年（对齐到所在周的周日）
const todayStr = ref(new Date().toISOString().slice(0, 10))
const contributionStart = computed(() => {
  const start = new Date(`${todayStr.value}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 364)
  const dow = start.getUTCDay()
  if (dow !== 0) start.setUTCDate(start.getUTCDate() - dow)
  return start.toISOString().slice(0, 10)
})
const contributionDays = computed(() => checkinHistory.value?.data?.days ?? [])

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
  public_id?: string
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

// 当前登录用户是否在查看自己的主页。
// userId 来自 URL（userUrl 生成 /users/{username}），故用 username 对比；
// 用 id 对比会因类型不同（UUID vs username）导致自己主页误判为他人主页，
// 从而错误地显示关注/私信按钮。
const isOwnProfile = computed(
  () => currentUser.value?.username === userId,
)

// 语言标签（统一走 utils/submissionFormat 的 getLanguageLabel）

// 结果状态
const resultBadgeColors: Record<string, string> = {
  finished: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-800",
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
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <!-- 通过 / 总提交（合并，通过数字更大且为绿色） -->
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">通过 / 提交</span>
          <p class="flex items-baseline gap-1.5">
            <span class="text-3xl font-bold text-green-600">{{ profile.stats.accepted }}</span>
            <span class="text-lg font-semibold text-text-muted">/ {{ profile.stats.total_submissions }}</span>
          </p>
        </div>
        <!-- 通过率（蓝色渐变填充背景，随百分比变化） -->
        <div class="bg-white border border-border rounded-xl px-5 py-4 flex flex-col gap-1 overflow-hidden">
          <span class="text-xs text-text-muted font-medium uppercase tracking-wide">通过率</span>
          <span class="text-2xl font-bold text-text">
            {{ (profile.stats.acceptance_rate * 100).toFixed(1) }}%
          </span>
          <div class="mt-1 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: `${Math.min(100, Math.max(0, profile.stats.acceptance_rate * 100))}%` }"
            ></div>
          </div>
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

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- 社交：关注 + 粉丝 -->
        <div class="rounded-xl border border-border bg-white px-5 py-4">
          <h3 class="text-sm font-semibold text-text">社交</h3>
          <div class="mt-3 flex items-center gap-8">
            <div class="flex flex-col gap-1"><span class="text-xs text-text-muted">关注</span><p class="text-2xl font-bold text-text">{{ profile.community_stats.following_count }}</p></div>
            <div class="flex flex-col gap-1"><span class="text-xs text-text-muted">粉丝</span><p class="text-2xl font-bold text-text">{{ profile.community_stats.follower_count }}</p></div>
          </div>
        </div>
        <!-- 我的创作：题解 + 动态 -->
        <div class="rounded-xl border border-border bg-white px-5 py-4">
          <h3 class="text-sm font-semibold text-text">我的创作</h3>
          <div class="mt-3 flex items-center gap-8">
            <div class="flex flex-col gap-1"><span class="text-xs text-text-muted">题解</span><p class="text-2xl font-bold text-text">{{ profile.community_stats.solution_count }}</p></div>
            <div class="flex flex-col gap-1"><span class="text-xs text-text-muted">动态</span><p class="text-2xl font-bold text-text">{{ profile.community_stats.moment_count }}</p></div>
          </div>
        </div>
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

        <div v-else-if="!checkinStatsData" class="mt-3 text-sm text-text-muted">
          暂无签到数据
        </div>

        <template v-else>
          <div class="mt-3 flex flex-col gap-5 lg:flex-row lg:items-stretch">
            <!-- 数据卡片（竖屏在上，横屏在左；两卡各占 (日历高-间距)/2，与右侧日历等高） -->
            <div class="flex shrink-0 flex-col self-stretch gap-3 lg:w-72">
              <!-- 卡片 1：当前连续 | 最长连续 -->
              <div class="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border rounded-lg border border-border bg-white">
                <div class="flex flex-col gap-1 px-4 py-3 text-center">
                  <span class="text-xs text-text-muted">当前连续</span>
                  <p class="text-xl font-bold text-primary">{{ checkinStatsData.current_streak }}<span class="text-xs font-normal text-text-muted"> 天</span></p>
                </div>
                <div class="flex flex-col gap-1 px-4 py-3 text-center">
                  <span class="text-xs text-text-muted">最长连续</span>
                  <p class="text-xl font-bold text-text">{{ checkinStatsData.max_streak }}<span class="text-xs font-normal text-text-muted"> 天</span></p>
                </div>
              </div>
              <!-- 卡片 2：本月签到 + 累计签到 -->
              <div class="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border rounded-lg border border-border bg-white">
                <div class="flex flex-col gap-1 px-4 py-3 text-center">
                  <span class="text-xs text-text-muted">本月签到</span>
                  <p class="text-xl font-bold text-text">{{ checkinStatsData.month_days }}<span class="text-xs font-normal text-text-muted"> 天</span></p>
                </div>
                <div class="flex flex-col gap-1 px-4 py-3 text-center">
                  <span class="text-xs text-text-muted">累计签到</span>
                  <p class="text-xl font-bold text-text">{{ checkinStatsData.total_days }}<span class="text-xs font-normal text-text-muted"> 天</span></p>
                </div>
              </div>
            </div>
            <!-- 贡献图（横屏时在右侧，与左侧两卡片组合等高） -->
            <div class="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-white p-4">
              <CheckinContributionGraph
                :days="contributionDays"
                :start-date="contributionStart"
                :today="todayStr"
              />
            </div>
          </div>
        </template>
      </section>

      <section v-if="profile.solutions.length || profile.moments.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-bg-page">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-messages-square" class="text-primary size-4.5" />
            社区内容
          </h2>
        </div>
        <div class="divide-y divide-border">
          <NuxtLink v-for="solution in profile.solutions" :key="solution.id" :to="publicUrl('post', solution.public_id || solution.id)" class="flex items-center gap-2 px-6 py-3 text-sm text-primary no-underline hover:bg-primary-bg">
            <UIcon name="i-lucide-lightbulb" class="size-4 shrink-0" />题解 · {{ solution.title }}
          </NuxtLink>
          <NuxtLink v-for="moment in profile.moments" :key="moment.id" :to="publicUrl('post', moment.public_id || moment.id)" class="flex items-center gap-2 px-6 py-3 text-sm text-primary no-underline hover:bg-primary-bg">
            <UIcon name="i-lucide-pen-line" class="size-4 shrink-0" /><span class="line-clamp-1">动态 · {{ moment.content }}</span>
          </NuxtLink>
        </div>
      </section>

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
              :to="problemUrl(problem.id, problem.display_id)"
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
                :to="problemUrl(problem.id, problem.display_id)"
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
            :to="publicUrl('training', training.public_id || training.id)"
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
                :to="publicUrl('submission', sub.public_id || sub.id)"
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
