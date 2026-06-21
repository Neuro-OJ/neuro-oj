<script setup lang="ts">
import { useRoute } from "vue-router"
import hljs from "highlight.js"
import "highlight.js/styles/github-dark.css"
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Server,
  Loader2,
  ChevronDown,
  ChevronUp,
  FileText,
  ArrowLeft,
} from "@lucide/vue"

definePageMeta({ ssr: false })

const route = useRoute()
const { token, isLoggedIn, loading } = useAuth()

const submissionId = route.params.id as string

// 等待 auth 就绪后检查登录状态
onMounted(() => {
  let unwatch: (() => void) | null = null
  unwatch = watch(
    loading,
    (loadingVal) => {
      if (!loadingVal) {
        if (unwatch) unwatch()
        unwatch = null
        nextTick(() => {
          if (!isLoggedIn.value) {
            navigateTo("/login")
          }
        })
      }
    },
    { immediate: true },
  )
})

interface SubmissionDetail {
  id: string
  problem_id: string
  language: string
  code: string
  file_name: string | null
  status: string
  created_at: string
  result: {
    status: string
    score: number
    output: string
    time_ms: number | null
    memory_kb: number | null
  } | null
}

interface SubmissionResponse {
  data: SubmissionDetail
}

const { data } = useFetch<SubmissionResponse>(
  `/api/v1/submissions/${submissionId}`,
  {
    headers: { Authorization: `Bearer ${token.value}` },
  },
)

const submission = computed(() => data.value?.data ?? null)
const isFinished = computed(
  () => submission.value?.status === "finished" || submission.value?.status === "error",
)
const showOutput = ref(true)

// 自动轮询：不依赖初始 useFetch，挂载后立即开始，直到状态变为 finished/error
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollSubmission() {
  if (!token.value) return // auth 还未就绪，下次重试
  try {
    const res = await $fetch<SubmissionResponse>(
      `/api/v1/submissions/${submissionId}`,
      { headers: { Authorization: `Bearer ${token.value}` } },
    )
    if (res) {
      data.value = res
      const status = res.data?.status
      if (status === "finished" || status === "error") {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
    }
  } catch {
    // 轮询失败静默处理——下一轮会重试
  }
}

onMounted(() => {
  // 立即拉一次
  pollSubmission()
  // 每秒轮询
  pollTimer = setInterval(pollSubmission, 1000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

// 状态标签
const statusLabel: Record<string, string> = {
  pending: "等待评测",
  judging: "评测中",
  finished: "已完成",
  error: "系统错误",
}

// 结果状态映射
interface ResultDef {
  label: string
  icon: string
  class: string
}

const resultDefMap: Record<string, ResultDef> = {
  Accepted: { label: "答案正确", icon: "check", class: "accepted" },
  WrongAnswer: { label: "答案错误", icon: "x", class: "wrong" },
  TimeLimitExceeded: { label: "超出时间限制", icon: "alert", class: "tle" },
  MemoryLimitExceeded: { label: "超出内存限制", icon: "alert", class: "mle" },
  RuntimeError: { label: "运行时错误", icon: "x", class: "re" },
  SystemError: { label: "系统错误", icon: "x", class: "se" },
}

function getResultDef(status: string | undefined): ResultDef {
  if (!status) return { label: status ?? "未知", icon: "x", class: "se" }
  return resultDefMap[status] ?? { label: status, icon: "x", class: "se" }
}

// Tailwind 判定颜色（完整字面量确保 JIT 识别）
const verdictClasses: Record<string, string> = {
  accepted: "bg-green-50 border border-green-200 text-green-700",
  wrong: "bg-red-50 border border-red-200 text-red-800",
  tle: "bg-orange-50 border border-orange-200 text-orange-800",
  mle: "bg-orange-50 border border-orange-200 text-orange-800",
  re: "bg-red-50 border border-red-200 text-red-800",
  se: "bg-red-50 border border-red-200 text-red-800",
}

const statusBadgeColors: Record<string, string> = {
  pending: "bg-gray-50 text-slate-500 border border-border",
  judging: "bg-blue-50 text-blue-700 border border-blue-200",
  error: "bg-red-50 text-red-800 border border-red-200",
}

function formatScore(raw: number | undefined): string {
  if (raw === undefined || raw === null) return "--"
  return (raw / 100).toFixed(1)
}

function formatTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "--"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatMemory(kb: number | undefined | null): string {
  if (kb === undefined || kb === null) return "--"
  if (kb < 1024) return `${kb}KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)}MB`
  return `${(kb / 1024 / 1024).toFixed(2)}GB`
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "--"
  const d = new Date(iso)
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

// 语言标签
const languageLabel: Record<string, string> = {
  python3: "Python 3",
  python: "Python",
  cpp: "C++",
  c: "C",
  javascript: "JavaScript",
}

// highlight.js 语言映射
const hljsLangMap: Record<string, string> = {
  python3: "python",
  python: "python",
  cpp: "cpp",
  c: "c",
  javascript: "javascript",
}

const codeRef = ref<HTMLElement>()
const codeLanguage = computed(() =>
  hljsLangMap[submission.value?.language ?? ""] || "plaintext",
)

onMounted(() => {
  if (codeRef.value) {
    hljs.highlightElement(codeRef.value)
  }
})
</script>

<template>
  <div class="max-w-[800px] mx-auto px-3 py-5 sm:px-6 sm:py-8 flex flex-col gap-5">
    <!-- 回退链接 -->
    <NuxtLink
      v-if="submission"
      :to="`/problems/${submission.problem_id}`"
      class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
    >
      <ArrowLeft :size="16" />
      返回题目
    </NuxtLink>

    <!-- Loading -->
    <div v-if="!submission" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>加载中...</span>
    </div>

    <template v-else>
      <!-- 头部卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="flex items-center justify-between px-6 pt-5">
          <h1 class="text-lg font-bold">提交结果</h1>
          <span class="font-mono text-xs text-text-muted">#{{ submission.id.slice(0, 8) }}</span>
        </div>

        <div class="px-6 py-7 flex justify-center">
          <!-- 等待/评测中 -->
          <div
            v-if="submission.status === 'pending' || submission.status === 'judging'"
            class="inline-flex items-center gap-2.5 px-7 py-3 rounded-full text-base font-semibold"
            :class="statusBadgeColors[submission.status]"
          >
            <Loader2 :size="20" class="animate-spin" />
            <span>{{ submission.status === 'pending' ? '等待评测' : '评测中' }}</span>
          </div>

          <div
            v-else-if="submission.status === 'error'"
            class="inline-flex items-center gap-2.5 px-7 py-3 rounded-full text-base font-semibold bg-red-50 text-red-800 border border-red-200"
          >
            <XCircle :size="22" />
            <span>系统错误</span>
          </div>

          <!-- 已完成 -->
          <div
            v-else-if="submission.result"
            class="flex items-center gap-4 px-9 py-5 rounded-2xl flex-col text-center sm:flex-row sm:text-left"
            :class="verdictClasses[getResultDef(submission.result.status).class] || verdictClasses.se"
          >
            <CheckCircle
              v-if="getResultDef(submission.result.status).icon === 'check'"
              :size="32"
            />
            <XCircle
              v-else-if="getResultDef(submission.result.status).icon === 'x'"
              :size="32"
            />
            <AlertTriangle v-else :size="32" />
            <div class="flex flex-col gap-0.5">
              <span class="text-lg font-bold">
                {{ getResultDef(submission.result.status).label }}
              </span>
              <span class="text-2xl font-extrabold">
                {{ formatScore(submission.result.score) }} 分
              </span>
            </div>
          </div>
        </div>

        <!-- 元信息 -->
        <div class="px-6 pb-4 flex flex-col gap-2">
          <div class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">题目</span>
            <NuxtLink
              :to="`/problems/${submission.problem_id}`"
              class="text-primary no-underline hover:underline"
            >
              {{ submission.problem_id }}
            </NuxtLink>
          </div>
          <div class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">语言</span>
            <span class="text-text">
              {{ languageLabel[submission.language] || submission.language }}
            </span>
          </div>
          <div class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">提交时间</span>
            <span class="text-text">
              {{ formatDateTime(submission.created_at) }}
            </span>
          </div>
        </div>

        <!-- 资源消耗（仅 finished） -->
        <div
          v-if="submission.result && submission.status === 'finished'"
          class="flex flex-col sm:flex-row gap-3 sm:gap-8 px-6 py-4 border-t border-border bg-gray-50"
        >
          <div class="flex items-center gap-2.5 text-text-secondary">
            <Clock :size="16" />
            <div class="flex flex-col gap-px">
              <span class="text-[11px] text-text-muted">耗时</span>
              <span class="text-sm font-semibold text-text">
                {{ formatTime(submission.result.time_ms) }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2.5 text-text-secondary">
            <Server :size="16" />
            <div class="flex flex-col gap-px">
              <span class="text-[11px] text-text-muted">内存</span>
              <span class="text-sm font-semibold text-text">
                {{ formatMemory(submission.result.memory_kb) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 代码区 -->
      <div class="bg-[#0d1117] border border-[#30363d] rounded-xl overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-2.5 bg-[#161b22] text-[#8b949e] text-xs font-mono border-b border-[#30363d]">
          <FileText :size="16" />
          <span>{{ submission.file_name || "main.py" }}</span>
        </div>
        <pre class="p-4 overflow-x-auto text-xs leading-relaxed"><code :ref="codeRef" :class="`language-${codeLanguage}`" class="font-mono text-[#e6edf3] whitespace-pre">{{ submission.code }}</code></pre>
      </div>

      <!-- 输出区（仅 finished 有内容） -->
      <div
        v-if="submission.status === 'finished' && submission.result?.output"
        class="bg-white border border-border rounded-xl overflow-hidden"
      >
        <button
          class="flex items-center justify-between w-full px-4 py-3 bg-gray-50 border-0 border-b border-border text-sm font-semibold text-text cursor-pointer hover:bg-gray-100"
          @click="showOutput = !showOutput"
        >
          <span>评测输出</span>
          <ChevronDown v-if="!showOutput" :size="16" />
          <ChevronUp v-else :size="16" />
        </button>
        <pre v-show="showOutput" class="p-4 overflow-x-auto text-xs leading-relaxed bg-[#0d1117] text-[#e6edf3]"><code class="font-mono whitespace-pre-wrap break-all">{{ submission.result.output }}</code></pre>
      </div>
    </template>
  </div>
</template>
