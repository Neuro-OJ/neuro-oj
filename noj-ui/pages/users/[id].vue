<script setup lang="ts">
import { useRoute } from "vue-router"
import { CheckCircle, Clock, Server, Calendar, FileText, Code, Send } from "@lucide/vue"
import { useMessages } from "~/composables/useMessages"
import { useToast } from "~/composables/useToast"

const route = useRoute()
const router = useRouter()
const { user: currentUser } = useAuth()
const { findOrCreateConversation } = useMessages()
const { toast } = useToast()

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
}

interface ProfileResponse {
  data: UserProfile
}

const { data, pending, error, refresh } = useFetch<ProfileResponse>(
  `/api/v1/users/${userId}/profile`,
)

const profile = computed(() => data.value?.data ?? null)

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

// 当前登录用户是否在查看自己的主页
const isOwnProfile = computed(
  () => currentUser.value?.id === userId,
)

// 难度标签
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

// 语言标签
const languageLabel: Record<string, string> = {
  python3: "Python 3",
  python: "Python",
  cpp: "C++",
  c: "C",
  javascript: "JavaScript",
  java: "Java",
  nodejs: "Node.js",
}

// 结果状态
const resultBadgeColors: Record<string, string> = {
  Accepted: "bg-green-100 text-green-700",
  WrongAnswer: "bg-red-100 text-red-800",
  TimeLimitExceeded: "bg-orange-100 text-orange-800",
  MemoryLimitExceeded: "bg-orange-100 text-orange-800",
  RuntimeError: "bg-red-100 text-red-800",
  SystemError: "bg-red-100 text-red-800",
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "--"
  const d = new Date(iso)
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
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
  try {
    await findOrCreateConversation(userId)
    router.push(`/messages`)
  } catch {
    toast.error("无法创建会话")
  }
}

function formatScore(raw: number | null | undefined): string {
  if (raw === undefined || raw === null) return "--"
  return (raw / 100).toFixed(1)
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
              <!-- 头像占位 -->
              <div class="w-16 h-16 rounded-full bg-primary-bg flex items-center justify-center text-primary text-2xl font-bold shrink-0">
                {{ profile.user.username.charAt(0).toUpperCase() }}
              </div>
              <div class="flex flex-col gap-1.5">
                <h1 class="text-2xl font-bold text-text">{{ profile.user.username }}</h1>
                <div class="flex items-center gap-2 text-sm text-text-muted">
                  <Calendar :size="14" />
                  <span>{{ formatDate(profile.user.created_at) }} 注册</span>
                </div>
              </div>
            </div>
            <!-- 编辑个人资料按钮（仅自己可见） -->
            <NuxtLink
              v-if="isOwnProfile"
              to="/settings"
              class="btn btn-outline text-xs px-3 py-1.5"
            >
              编辑个人资料
            </NuxtLink>
            <!-- 发送私信按钮（查看他人主页时显示） -->
            <button
              v-else-if="currentUser"
              class="btn btn-outline text-xs px-3 py-1.5 flex items-center gap-1.5"
              @click="startConversation"
            >
              <Send :size="14" />
              发送私信
            </button>
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

      <!-- 已通过题目 -->
      <div v-if="profile.solved_problems.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-gray-50">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <CheckCircle :size="18" class="text-green-600" />
            已通过题目
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="problem in profile.solved_problems"
            :key="problem.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-gray-50"
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
                :class="badgeColors[problem.difficulty] || ''"
              >
                {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
              </span>
              <span class="text-xs text-text-muted">{{ formatDate(problem.accepted_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 创建的题目 -->
      <div v-if="createdProblems.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-gray-50">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <FileText :size="18" class="text-primary" />
            创建的题目
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="problem in createdProblems"
            :key="problem.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-gray-50"
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
                :class="badgeColors[problem.difficulty] || ''"
              >
                {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
              </span>
              <span class="text-xs text-text-muted">{{ formatDate(problem.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 最近提交 -->
      <div v-if="profile.recent_submissions.length" class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-border bg-gray-50">
          <h2 class="text-base font-semibold flex items-center gap-2">
            <Clock :size="18" class="text-text-secondary" />
            最近提交
          </h2>
        </div>
        <div class="divide-y divide-border">
          <div
            v-for="sub in profile.recent_submissions"
            :key="sub.id"
            class="flex items-center justify-between px-6 py-3 hover:bg-gray-50"
          >
            <div class="flex items-center gap-3 min-w-0">
              <NuxtLink
                :to="`/submissions/${sub.id}`"
                class="text-sm text-primary no-underline hover:underline truncate"
              >
                {{ sub.problem_title || sub.problem_id }}
              </NuxtLink>
              <span class="text-xs text-text-muted whitespace-nowrap shrink-0">
                {{ languageLabel[sub.language] || sub.language }}
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
