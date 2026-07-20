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
  Lock,
} from "@lucide/vue"
import { getLanguageLabel, formatScore, formatTime, formatMemory, statusBadgeColors, getResultDef, verdictClasses, formatDateTime } from "~/composables/use-submissions"

interface SubmissionResult {
  status: string
  score: number
  time_ms: number | null
  memory_kb: number | null
  /** 评测输出：未登录或非 owner/admin 时为 null */
  output: string | null
  output_truncated?: boolean
  details?: Record<string, unknown> | null
}
interface SubmissionData {
  id: string
  problem_id: string
  language: string
  /** 源代码：未登录或非 owner/admin 时为 null */
  code: string | null
  file_name: string
  status: string
  queue_position?: number
  queue_length?: number
  judge_started_at?: string
  created_at: string
  result?: SubmissionResult
}
interface SubmissionResponse {
  data: SubmissionData
}
const route = useRoute()
const { isLoggedIn, loading: authLoading } = useAuth()
const submissionId = route.params.id as string
// 不使用 useFetch（setup 阶段 token 可能未就绪），改为手动管理
const isMounted = ref(true)
const data = ref<SubmissionResponse | null>(null)
const submission = computed(() => data.value?.data ?? null)
const isFinished = computed(
  () => submission.value?.status === "finished" || submission.value?.status === "error",
)
const showOutput = ref(true)
// 自动轮询：基础数据公开访问，未登录也能查看；等 auth token 就绪后开始轮询
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollReqId = 0
const POLL_INTERVAL_MS = 1500
async function pollSubmission() {
  if (!isMounted.value) return
  const thisReq = ++pollReqId
  try {
    const res = await $fetch<SubmissionResponse>(
      `/api/v1/submissions/${submissionId}`,
    )
    if (!isMounted.value || thisReq !== pollReqId) return
      if (res) {
      data.value = res
      const status = res.data?.status
      if (status === "finished" || status === "error") {
        stopPolling()
      }
    }
  } catch (err: unknown) {
    if (!isMounted.value) return
  }
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
// auth 状态确定后开始轮询（无论登录与否都能轮询基础数据）
watch(
  authLoading,
  (authLoadingVal) => {
    if (import.meta.server) return // SSR 阶段无 cookie，客户端水合后接管
    if (!authLoadingVal && !pollTimer) {
      pollSubmission()
      pollTimer = setInterval(pollSubmission, POLL_INTERVAL_MS)
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  stopPolling()
  isMounted.value = false
})
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
// 使用 watch 而非 onMounted（数据加载前 codeRef 指向空）
watch(
  () => submission.value?.code,
  (code) => {
    if (code && codeRef.value) {
      nextTick(() => hljs.highlightElement(codeRef.value!))
    }
  },
  { immediate: true },
)
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
            <span v-if="submission.status === 'pending' && submission.queue_position != null" class="queue-pos">
              #{{ submission.queue_position }}/{{ submission.queue_length }}
            </span>
            <span v-if="submission.status === 'judging' && submission.judge_started_at" class="queue-pos">
              {{ formatDateTime(submission.judge_started_at) }} 开始
            </span>
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
              {{ getLanguageLabel(submission.language) }}
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
        <pre v-if="submission.code !== null" class="p-4 overflow-x-auto text-xs leading-relaxed"><code :ref="codeRef" :class="`language-${codeLanguage}`" class="font-mono text-[#e6edf3] whitespace-pre">{{ submission.code }}</code></pre>
        <div v-else class="flex flex-col items-center justify-center gap-2 py-12 text-[#8b949e] text-sm">
          <Lock :size="24" />
          <span>登录后查看源代码</span>
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="inline-flex items-center px-4 py-1.5 rounded-md text-xs font-semibold bg-primary text-white border border-primary no-underline hover:bg-primary-dark hover:border-primary-dark"
          >
            登录
          </NuxtLink>
        </div>
      </div>
      <!-- 输出区（仅 finished 有内容） -->
      <div
        v-if="submission.status === 'finished' && submission.result"
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
        <pre v-if="submission.result.output !== null && submission.result.output !== undefined" v-show="showOutput" class="p-4 overflow-x-auto text-xs leading-relaxed bg-[#0d1117] text-[#e6edf3]"><code class="font-mono whitespace-pre-wrap break-all">{{ submission.result.output }}</code></pre>
        <div v-else class="flex flex-col items-center justify-center gap-2 py-8 text-text-muted text-sm">
          <Lock :size="20" />
          <span>登录后查看评测输出</span>
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="inline-flex items-center px-4 py-1.5 rounded-md text-xs font-semibold bg-primary text-white border border-primary no-underline hover:bg-primary-dark hover:border-primary-dark"
          >
            登录
          </NuxtLink>
        </div>
      </div>
    </template>
  </div>
</template>
