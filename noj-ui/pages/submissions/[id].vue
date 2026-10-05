<script setup lang="ts">
import { useRoute } from "vue-router"
import hljs from "highlight.js"
import "highlight.js/styles/github-dark.css"
import SubmissionCaseResults from "~/components/submission/SubmissionCaseResults.vue"
import SubmissionOutputPanel from "~/components/submission/SubmissionOutputPanel.vue"
import { useCopyText } from "~/composables/useCopyText"
import { getLanguageLabel, formatScore, formatTime, formatMemory, statusBadgeColors, getResultDef, verdictClasses, formatDateTime } from "~/utils/submissionFormat"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"
import { useBreadcrumbLabel } from '~/composables/useBreadcrumb'

interface SubmissionResult {
  status: string
  score: number
  time_ms: number | null
  memory_kb: number | null
  /** 评测输出：未登录或非 owner/admin 时为 null */
  output: string | null
  output_truncated?: boolean
  details?: Record<string, unknown> | null
  metering?: Record<string, unknown>
}
interface SubmissionData {
  id: string
  public_id?: string
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
const { api } = useApi()
const { isLoggedIn, loading: authLoading } = useAuth()
const submissionId = route.params.id as string
// 不使用 useFetch（setup 阶段 token 可能未就绪），改为手动管理
const isMounted = ref(true)
const data = ref<SubmissionResponse | null>(null)
const submission = computed(() => data.value?.data ?? null)

// 面包屑（#512）：末层显示提交公开编号，而非裸 UUID
useBreadcrumbLabel(() => submission.value?.public_id)

useSeoMeta({
  title: () => submission.value?.public_id ? `提交 #${submission.value.public_id} - Neuro OJ` : '提交结果 - Neuro OJ',
  description: 'Neuro OJ 提交结果详情',
  ogTitle: () => submission.value?.public_id ? `提交 #${submission.value.public_id} - Neuro OJ` : 'Neuro OJ',
  ogDescription: 'Neuro OJ 提交结果详情',
})

const isFinished = computed(
  () => submission.value?.status === "finished" || submission.value?.status === "error",
)
const showCode = ref(false)
const { copyText } = useCopyText()
// 自动轮询：基础数据公开访问，未登录也能查看；等 auth token 就绪后开始轮询
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollReqId = 0
const POLL_INTERVAL_MS = 1500
async function pollSubmission() {
  if (!isMounted.value) return
  const thisReq = ++pollReqId
  try {
    const res = await api.get<SubmissionResponse>(
      `/api/v1/submissions/${submissionId}`,
      { silent: true },
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
const codeRef = ref<HTMLElement | null>(null)
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
    <!-- 「返回题目」已由面包屑（#512）承担；此入口保留为题目的直达链接，
         因为它指向提交对应的题目，而非父层级 -->
    <NuxtLink
      v-if="submission"
      :to="problemUrl(submission.problem_id)"
      class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
    >
      <UIcon name="i-lucide-arrow-right" class="size-4" />
      查看题目
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
          <span class="font-mono text-xs text-text-muted">#{{ submission.public_id || submission.id.slice(0, 8) }}</span>
        </div>
        <div class="px-6 py-7 flex justify-center">
          <!-- 等待/评测中 -->
          <div
            v-if="submission.status === 'pending' || submission.status === 'judging'"
            class="inline-flex items-center gap-2.5 px-7 py-3 rounded-full text-base font-semibold"
            :class="statusBadgeColors[submission.status]"
          >
            <UIcon name="i-lucide-loader-2" class="animate-spin size-5" />
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
            <UIcon name="i-lucide-x-circle" class="size-[22px]" />
            <span>出错</span>
          </div>
          <!-- 已完成 -->
          <div
            v-else-if="submission.result"
            class="flex items-center gap-4 px-9 py-5 rounded-2xl flex-col text-center sm:flex-row sm:text-left"
            :class="verdictClasses[getResultDef(submission.result.status).class] || verdictClasses.se"
          >
            <UIcon name="i-lucide-check-circle" class="size-8" v-if="getResultDef(submission.result.status).icon === 'check'"/>
            <UIcon name="i-lucide-x-circle" class="size-8" v-else-if="getResultDef(submission.result.status).icon === 'x'"/>
            <UIcon name="i-lucide-alert-triangle" class="size-8" v-else/>
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
              :to="problemUrl(submission.problem_id)"
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
          class="flex flex-col sm:flex-row gap-3 sm:gap-8 px-6 py-4 border-t border-border bg-bg-page"
        >
          <div class="flex items-center gap-2.5 text-text-secondary">
            <UIcon name="i-lucide-clock" class="size-4" />
            <div class="flex flex-col gap-px">
              <span class="text-11px text-text-muted">耗时</span>
              <span class="text-sm font-semibold text-text">
                {{ formatTime(submission.result.time_ms) }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2.5 text-text-secondary">
            <UIcon name="i-lucide-server" class="size-4" />
            <div class="flex flex-col gap-px">
              <span class="text-11px text-text-muted">内存</span>
              <span class="text-sm font-semibold text-text">
                {{ formatMemory(submission.result.memory_kb) }}
              </span>
            </div>
          </div>
        </div>
      </div>
      <!-- 测试点明细（挪到提交代码上方） -->
      <section v-if="submission.result?.metering" class="rounded-md border border-border p-4 text-sm">
        <h2 class="font-semibold">WASM 计量与可比标识</h2>
        <p v-if="submission.result.metering.legacy" class="mt-2 text-text-secondary">旧计量结果：无统一 WASM 标识，不能用于跨实例比较；请重测以获得新结果。</p>
        <template v-else>
          <p class="mt-2">{{ submission.result.metering.standard_version }} · {{ submission.result.metering.comparable ? '具备可比标识' : '评测环境异常，不具备可比性' }}</p>
          <p v-if="submission.result.metering.termination_reason === 'host_watchdog'" class="mt-2 text-error-text">运行保护超时，请降低负载后重测。</p>
          <p v-if="submission.result.metering.termination_reason === 'standard_mismatch'" class="mt-2 text-error-text">任务标准不匹配，请重测。</p>
          <p class="mt-1 text-xs text-text-secondary">等效时间表示固定工作量，不是实际 CPU 耗时。可比标识不代表来源可信。</p>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            <template v-for="(label, key) in { standard_hash: '标准摘要', source_hash: '源码摘要', evaluation_hash: '题目评测摘要', module_hash: '编译产物摘要', comparison_hash: '可比标识' }" :key="key">
              <dt>{{ label }}</dt><dd class="break-all font-mono">{{ submission.result.metering[key] ?? '未生成' }}</dd>
            </template>
          </dl>
          <details v-if="submission.result.details?.oi" class="mt-3"><summary class="cursor-pointer">查看测试点计量数据（fuel、预算和等效时间）</summary><pre class="mt-2 max-h-80 overflow-auto text-xs">{{ JSON.stringify(submission.result.details.oi, null, 2) }}</pre></details>
        </template>
      </section>

      <SubmissionCaseResults
        v-if="submission.status === 'finished' && submission.result"
        :details="submission.result.details"
      />
      <!-- 提交代码 -->
      <div class="bg-[#0d1117] border border-[#30363d] rounded-xl overflow-hidden">
        <button
          class="flex items-center justify-between w-full px-4 py-3 bg-[#161b22] text-[#8b949e] text-xs font-mono border-b border-[#30363d] cursor-pointer hover:bg-[#1c2128]"
          @click="showCode = !showCode"
        >
          <span class="flex items-center gap-2">
            <UIcon name="i-lucide-file-text" class="size-4" />
            <span>提交代码</span>
            <span class="text-[#8b949e]/60">{{ submission.file_name || "main.py" }}</span>
          </span>
          <span class="flex items-center gap-2">
            <UIcon
              v-if="submission.code !== null"
              name="i-lucide-copy"
              class="size-4 hover:text-[#e6edf3]"
              title="复制代码"
              @click.stop="copyText(submission.code, '代码')"
            />
            <UIcon name="i-lucide-chevron-down" class="size-4" v-if="!showCode"/>
            <UIcon name="i-lucide-chevron-up" class="size-4" v-else/>
          </span>
        </button>
        <pre v-if="submission.code !== null" v-show="showCode" class="p-4 overflow-x-auto text-xs leading-relaxed"><code ref="codeRef" :class="`language-${codeLanguage}`" class="font-mono text-[#e6edf3] whitespace-pre">{{ submission.code }}</code></pre>
        <div v-else class="flex flex-col items-center justify-center gap-2 py-12 text-[#8b949e] text-sm">
          <UIcon name="i-lucide-lock" class="size-6" />
          <span>登录后查看源代码</span>
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="inline-flex items-center px-4 py-1.5 rounded-md text-xs font-semibold bg-signal text-on-signal border border-signal no-underline hover:bg-signal/80 hover:border-signal/80"
          >
            登录
          </NuxtLink>
        </div>
      </div>
      <!-- 输出区：finished / error 终态均展示（error 的 output 携带出错原因） -->
      <SubmissionOutputPanel
        v-if="isFinished && submission.result"
        :status="submission.status"
        :output="submission.result.output"
        :is-logged-in="isLoggedIn"
        @copy="copyText($event, '评测输出')"
      />
    </template>
  </div>
</template>
