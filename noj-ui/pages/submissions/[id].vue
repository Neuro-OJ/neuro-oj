<script setup lang="ts">
import { useRoute } from "vue-router"
import hljs from "highlight.js"
import "highlight.js/styles/github-dark.css"
import SubmissionCaseResults from "~/components/submission/SubmissionCaseResults.vue"
import SubmissionOutputPanel from "~/components/submission/SubmissionOutputPanel.vue"
import { useCopyText } from "~/composables/useCopyText"
import { getLanguageLabel, formatScore, formatTime, formatMemory, statusBadgeColors, getResultDef, verdictClasses, formatDateTime, submissionVersionLabel, resultLabels } from "~/utils/submissionFormat"
import { problemUrl, publicUrl } from "~/utils/publicIdentifiers"
import { useBreadcrumbLabel } from '~/composables/useBreadcrumb'
import { problemJudgeTypeLabel, type ProblemResource } from '~/utils/problemView'
import { submissionMeteringCases, submissionMeteringTimeLabel } from '~/utils/submissionMetering'

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
/** 单个题目版本的当前正式判定（跨版本保留，Handbook 核心不变量 3）。 */
interface SubmissionVersionResult {
  problem_version_id: string | null
  version: number | null
  attempt_id: string
  sequence: number
  status: string
  score: number
  time_ms: number | null
  memory_kb: number | null
  /** 是否为当前有效成绩（按题目有效版本策略解析）。 */
  is_effective: boolean
  /** 是否为当前"通过"指针。 */
  is_accepted: boolean
}

/**
 * 单次正式评测尝试（`evaluation_attempts`，Handbook §2.8）。
 *
 * 与「每版本当前判定」是两件事：这里保留**全部执行**（初次 / 重测 / 升级 /
 * 存量导入），因此能看清"同一版本多次重测"的完整历史。
 */
interface SubmissionAttempt {
  attempt_id: string
  sequence: number
  problem_version_id: string | null
  version: number | null
  /** initial / rejudge / upgrade / legacy_import */
  source: string
  /** queued / judging / finished / error / superseded */
  state: string
  /** graded / platform_error；平台错误不替换已有正式判定。 */
  result_kind: 'graded' | 'platform_error' | null
  status: string
  score: number
  time_ms: number | null
  memory_kb: number | null
  is_effective: boolean
  is_accepted: boolean
  is_latest: boolean
  created_at: string
  finished_at: string | null
}
interface SubmissionData {
  progress?: {phase:string;active_cases:{case_id:string;subtask_id:string}[];completed_cases:Record<string,unknown>[];total_cases:number} | null
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
  /** 提交时版本 ID；迁移前历史提交为 null。 */
  submitted_version_id?: string | null
  /** 版本来源：known / legacy_unknown。 */
  version_origin?: string
  /** 提交时版本号（展示用）。 */
  submitted_version?: number | null
  /** 由升级任务派生时指向源提交（同题旧版）。 */
  upgraded_from_id?: string | null
  /** 题目作用域的有效版本策略（竞赛另有独立策略）。 */
  effective_version_policy?: { mode: 'any' } | { mode: 'exact'; version_id: string | null }
  /** 各版本当前正式判定。 */
  version_results?: SubmissionVersionResult[] | null
  /**
   * 提交时版本是否仍是该题最新已发布版本（提交行级，区别于 attempt 级 `is_latest`）。
   * `false` 且版本已知时可在列表页发起「升级到最新版」。
   */
  is_latest?: boolean
  /** 全部正式评测尝试（缺失时页面降级为仅展示现有字段）。 */
  attempts?: SubmissionAttempt[] | null
  /** 最近一次执行 / 有效成绩 / 通过指针的尝试 ID。 */
  latest_attempt_id?: string | null
  effective_attempt_id?: string | null
  accepted_attempt_id?: string | null
}

/** 提交时版本展示文案（未知历史版本必须显式说明）。 */
const versionLabel = computed(() => submissionVersionLabel({
  version_origin: submission.value?.version_origin,
  submitted_version: submission.value?.submitted_version,
}))

/** 各版本当前判定（按尝试序号升序，后端已排序，这里只做兜底）。 */
const versionResults = computed(() => submission.value?.version_results ?? [])

/** 有效版本策略文案。 */
const policyHint = computed(() => {
  const policy = submission.value?.effective_version_policy
  if (!policy) return ''
  return policy.mode === 'exact'
    ? '本题已固定版本：只有该版本的判定计入有效成绩'
    : '本题取所有已发布版本中的最高有效成绩'
})

/**
 * 提交时版本已不是该题最新已发布版本（Handbook §4.4 升级入口提示）。
 *
 * 只在版本**已知**时提示：`legacy_unknown`（迁移前无提交时版本）无法按提交时版本
 * 升级；后端未下发 `is_latest` 的老响应同样不提示。
 */
const isUpgradableVersion = computed(
  () =>
    submission.value?.version_origin === 'known' &&
    submission.value?.is_latest === false,
)

// ── 最近运行 / 有效成绩 / 完整尝试历史（Handbook §3.2-3.4、§6.8）──

/** 尝试来源文案。 */
const ATTEMPT_SOURCE_LABELS: Record<string, string> = {
  initial: '首次提交',
  rejudge: '重测',
  upgrade: '升级到新版',
  legacy_import: '存量导入',
}

function attemptSourceLabel(source: string): string {
  return ATTEMPT_SOURCE_LABELS[source] ?? source
}

/** 尝试状态文案：非终态用中性描述，终态沿用统一的结果文案。 */
function attemptStateLabel(attempt: SubmissionAttempt): string {
  if (attempt.state === 'queued') return '排队中'
  if (attempt.state === 'judging') return '评测中'
  if (attempt.state === 'superseded') return '已被取代'
  return resultLabels[attempt.status] ?? attempt.status
}

/** 全部正式尝试（按 sequence 升序；后端已排序，这里只做兜底）。 */
const attempts = computed(() => {
  const list = submission.value?.attempts
  if (!list || list.length === 0) return []
  return [...list].sort((a, b) => a.sequence - b.sequence)
})

/** 结果概览的统一形状（尝试 / 版本判定 / 详情结果三种来源归一）。 */
interface ResultSummary {
  /** 版本文案（v3 / 未知历史版本）。 */
  versionLabel: string
  status: string
  score: number
  timeMs: number | null
  memoryKb: number | null
  /** 尝试来源文案；版本判定兜底路径没有来源。 */
  sourceLabel: string | null
  accepted: boolean
  /** 平台错误（不替换已有正式判定，不等于选手答错）。 */
  platformError: boolean
  createdAt: string | null
}

function summaryFromAttempt(attempt: SubmissionAttempt): ResultSummary {
  return {
    versionLabel: attempt.version != null ? `v${attempt.version}` : '未知历史版本',
    status: attempt.status,
    score: attempt.score,
    timeMs: attempt.time_ms,
    memoryKb: attempt.memory_kb,
    sourceLabel: attemptSourceLabel(attempt.source),
    accepted: attempt.is_accepted,
    platformError: attempt.result_kind === 'platform_error',
    createdAt: attempt.created_at,
  }
}

function summaryFromVersionResult(item: SubmissionVersionResult): ResultSummary {
  return {
    versionLabel: item.version != null ? `v${item.version}` : '未知历史版本',
    status: item.status,
    score: item.score,
    timeMs: item.time_ms,
    memoryKb: item.memory_kb,
    sourceLabel: null,
    accepted: item.is_accepted,
    platformError: false,
    createdAt: null,
  }
}

/** 最近一次执行：优先 attempts 标记，其次指针 ID，最后退化为详情里的 result。 */
const latestSummary = computed<ResultSummary | null>(() => {
  const list = attempts.value
  const attempt = list.find((item) => item.is_latest) ??
    list.find((item) => item.attempt_id === submission.value?.latest_attempt_id)
  if (attempt) return summaryFromAttempt(attempt)
  const result = submission.value?.result
  if (!result) return null
  return {
    versionLabel: versionLabel.value,
    status: result.status,
    score: result.score,
    timeMs: result.time_ms,
    memoryKb: result.memory_kb,
    sourceLabel: null,
    accepted: false,
    platformError: false,
    createdAt: submission.value?.created_at ?? null,
  }
})

/** 有效成绩：当前策略选出的最高分指针。 */
const effectiveSummary = computed<ResultSummary | null>(() => {
  const list = attempts.value
  const attempt = list.find((item) => item.is_effective) ??
    list.find((item) => item.attempt_id === submission.value?.effective_attempt_id)
  if (attempt) return summaryFromAttempt(attempt)
  const fallback = versionResults.value.find((item) => item.is_effective)
  return fallback ? summaryFromVersionResult(fallback) : null
})

/** 通过指针（与最高分指针分开，Handbook §3.2）。 */
const acceptedSummary = computed<ResultSummary | null>(() => {
  const list = attempts.value
  const attempt = list.find((item) => item.is_accepted) ??
    list.find((item) => item.attempt_id === submission.value?.accepted_attempt_id)
  if (attempt) return summaryFromAttempt(attempt)
  const fallback = versionResults.value.find((item) => item.is_accepted)
  return fallback ? summaryFromVersionResult(fallback) : null
})

/** 最近一次执行是平台错误时的提示（Handbook §3.3）。 */
const latestIsPlatformError = computed(
  () => latestSummary.value?.platformError === true,
)
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
const linkedProblem = ref<ProblemResource | null>(null)
watch(() => submission.value?.problem_id, async (id, _previous, onCleanup) => {
  linkedProblem.value = null
  if (!id) return
  let active = true
  onCleanup(() => { active = false })
  try {
    const result = await api.get<{ data: ProblemResource }>(`/api/v1/problems/${id}`, { silent: true })
    if (active) linkedProblem.value = result.data
  } catch {
    // 不可见或已删除题目保留直达入口，不绕过题目的访问控制。
  }
})
const meteringTimeLabel = computed(() => submissionMeteringTimeLabel(submission.value?.result?.metering?.standard_version))
const meteringCases = computed(() => submissionMeteringCases(submission.value?.result?.details))
const actualBackend = computed(() => {
  const oi = submission.value?.result?.details?.oi as { backend?: string } | undefined
  if (oi?.backend === 'native' || oi?.backend === 'wasm') return `oi-${oi.backend}`
  const metering = submission.value?.result?.metering
  if (metering?.standard_version && !metering.legacy) return 'oi-wasm'
  return linkedProblem.value?.judge_backend ?? null
})
const judgeTypeLabel = computed(() => actualBackend.value?.startsWith('oi-') ? 'OI 题' : linkedProblem.value ? problemJudgeTypeLabel(linkedProblem.value) : null)

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
  cc: "cpp",
  c: "c",
  javascript: "javascript",
  ui: "json",
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
            :class="verdictClasses[getResultDef((submission.result.details?.oi as {verdict?:string})?.verdict ?? submission.result.status).class] || verdictClasses.se"
          >
            <UIcon name="i-lucide-check-circle" class="size-8" v-if="getResultDef((submission.result.details?.oi as {verdict?:string})?.verdict ?? submission.result.status).icon === 'check'"/>
            <UIcon name="i-lucide-x-circle" class="size-8" v-else-if="getResultDef((submission.result.details?.oi as {verdict?:string})?.verdict ?? submission.result.status).icon === 'x'"/>
            <UIcon name="i-lucide-alert-triangle" class="size-8" v-else/>
            <div class="flex flex-col gap-0.5">
              <span class="text-lg font-bold">
                {{ getResultDef((submission.result.details?.oi as {verdict?:string})?.verdict ?? submission.result.status).label }}
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
            <ProblemReference :id="submission.problem_id" :display-id="linkedProblem?.display_id" :title="linkedProblem?.title" />
          </div>
          <div v-if="judgeTypeLabel" class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">题目类型</span>
            <span>{{ judgeTypeLabel }}</span>
          </div>
          <div v-if="actualBackend || linkedProblem?.is_objective" class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">评测后端</span>
            <span class="font-mono">{{ actualBackend || '即时判定' }}</span>
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
          <!-- 提交时版本（Handbook §4.2）：不可变，赛后回看必须能确认"当时在评哪一版" -->
          <div class="flex gap-3 text-sm items-center">
            <span class="text-text-muted min-w-[70px] shrink-0">作答版本</span>
            <UBadge
              :color="submission.submitted_version != null ? 'primary' : 'neutral'"
              variant="subtle"
            >
              {{ versionLabel }}
            </UBadge>
            <span v-if="policyHint" class="text-text-muted text-xs">{{ policyHint }}</span>
            <NuxtLink
              v-if="isUpgradableVersion"
              :to="`/submissions?problem_id=${submission.problem_id}`"
              class="text-xs text-primary no-underline hover:underline"
            >
              本题已发布更新版本，可升级到最新版
            </NuxtLink>
          </div>
          <div v-if="submission.upgraded_from_id" class="flex gap-3 text-sm">
            <span class="text-text-muted min-w-[70px] shrink-0">来源</span>
            <NuxtLink
              :to="publicUrl('submission', submission.upgraded_from_id)"
              class="text-primary no-underline hover:underline"
            >
              由旧版本提交升级而来
            </NuxtLink>
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
      <!-- 结果概览（Handbook §6.8）：最近运行与有效成绩必须分开呈现 -->
      <section
        v-if="latestSummary || effectiveSummary || acceptedSummary"
        class="rounded-xl border border-border bg-white p-4"
      >
        <h2 class="text-sm font-semibold text-text">结果概览</h2>
        <p class="mt-1 text-xs text-text-muted">
          「最近运行」是最后一次执行；「有效成绩」是按本题有效版本策略选出的最高分判定。两者可能不同：
          有效已通过但最近一次运行失败时，成绩仍然有效。
        </p>
        <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <!-- 最近运行 -->
          <div class="rounded-lg border border-border bg-bg-page p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-semibold text-text-secondary">最近运行</span>
              <UBadge color="neutral" variant="subtle">{{ latestSummary?.versionLabel ?? "—" }}</UBadge>
              <UBadge v-if="latestSummary?.sourceLabel" color="primary" variant="subtle">
                {{ latestSummary.sourceLabel }}
              </UBadge>
              <UBadge v-if="latestIsPlatformError" color="warning" variant="subtle">平台错误</UBadge>
            </div>
            <template v-if="latestSummary">
              <p class="mt-2 text-sm text-text">
                {{ resultLabels[latestSummary.status] ?? latestSummary.status }}
                <span class="ml-2 font-semibold tabular-nums">{{ formatScore(latestSummary.score) }} 分</span>
              </p>
              <p class="mt-1 text-xs text-text-muted tabular-nums">
                {{ formatTime(latestSummary.timeMs) }} · {{ formatMemory(latestSummary.memoryKb) }}
                <template v-if="latestSummary.createdAt"> · {{ formatDateTime(latestSummary.createdAt) }}</template>
              </p>
            </template>
            <p v-else class="mt-2 text-xs text-text-muted">暂无执行记录</p>
          </div>

          <!-- 有效成绩 -->
          <div class="rounded-lg border border-border bg-bg-page p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-semibold text-text-secondary">有效成绩</span>
              <UBadge color="neutral" variant="subtle">{{ effectiveSummary?.versionLabel ?? "—" }}</UBadge>
              <UBadge v-if="effectiveSummary?.accepted" color="success" variant="subtle">通过</UBadge>
              <UBadge v-if="effectiveSummary?.platformError" color="warning" variant="subtle">平台错误</UBadge>
            </div>
            <template v-if="effectiveSummary">
              <p class="mt-2 text-sm text-text">
                {{ resultLabels[effectiveSummary.status] ?? effectiveSummary.status }}
                <span class="ml-2 font-semibold tabular-nums">{{ formatScore(effectiveSummary.score) }} 分</span>
              </p>
              <p class="mt-1 text-xs text-text-muted tabular-nums">
                {{ formatTime(effectiveSummary.timeMs) }} · {{ formatMemory(effectiveSummary.memoryKb) }}
                <template v-if="effectiveSummary.createdAt"> · {{ formatDateTime(effectiveSummary.createdAt) }}</template>
              </p>
              <p v-if="acceptedSummary" class="mt-1 text-11px text-text-muted">
                通过指针：{{ acceptedSummary.versionLabel }}
                <template v-if="effectiveSummary.versionLabel !== acceptedSummary.versionLabel">（最高分与通过判定来自不同版本）</template>
              </p>
            </template>
            <p v-else class="mt-2 text-xs text-text-muted">当前策略下没有有效成绩</p>
          </div>
        </div>
        <p v-if="latestIsPlatformError" class="mt-2 flex items-center gap-1.5 text-xs text-warning-text">
          <UIcon name="i-lucide-alert-triangle" class="size-3.5" />
          最近一次执行发生平台错误（非选手答错），已有正式判定不受影响。
        </p>
      </section>

      <!-- 尝试历史（Handbook §2.8）：同版本多次重测的完整执行记录 -->
      <section v-if="attempts.length > 0" class="rounded-xl border border-border bg-white p-4">
        <h2 class="text-sm font-semibold text-text">尝试历史</h2>
        <p class="mt-1 text-xs text-text-muted">
          每次正式执行（首次提交 / 重测 / 升级 / 存量导入）都是一条独立尝试；重测只新增尝试，不覆盖历史。
        </p>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-border text-text-secondary">
              <tr>
                <th scope="col" class="p-2 text-left">#</th>
                <th scope="col" class="p-2 text-left">版本</th>
                <th scope="col" class="p-2 text-left">来源</th>
                <th scope="col" class="p-2 text-left">状态</th>
                <th scope="col" class="p-2 text-right">分数</th>
                <th scope="col" class="p-2 text-right">耗时</th>
                <th scope="col" class="p-2 text-right">内存</th>
                <th scope="col" class="p-2 text-left">执行时间</th>
                <th scope="col" class="p-2 text-left">标记</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="attempt in attempts"
                :key="attempt.attempt_id"
                class="border-b border-border"
                :class="{ 'opacity-60': attempt.state === 'superseded' }"
              >
                <td class="p-2 tabular-nums">{{ attempt.sequence }}</td>
                <td class="p-2 font-mono">
                  {{ attempt.version != null ? `v${attempt.version}` : "未知历史版本" }}
                </td>
                <td class="p-2 text-xs text-text-secondary">{{ attemptSourceLabel(attempt.source) }}</td>
                <td class="p-2 text-xs">
                  <span :class="attempt.result_kind === 'platform_error' ? 'text-warning-text' : 'text-text'">
                    {{ attemptStateLabel(attempt) }}
                  </span>
                </td>
                <td class="p-2 text-right tabular-nums">{{ formatScore(attempt.score) }}</td>
                <td class="p-2 text-right tabular-nums">{{ formatTime(attempt.time_ms) }}</td>
                <td class="p-2 text-right tabular-nums">{{ formatMemory(attempt.memory_kb) }}</td>
                <td class="p-2 text-xs text-text-secondary tabular-nums">{{ formatDateTime(attempt.created_at) }}</td>
                <td class="p-2">
                  <span class="flex flex-wrap gap-1.5">
                    <UBadge v-if="attempt.is_latest" color="neutral" variant="subtle">最近运行</UBadge>
                    <UBadge v-if="attempt.is_effective" color="primary" variant="subtle">有效成绩</UBadge>
                    <UBadge v-if="attempt.is_accepted" color="success" variant="subtle">通过</UBadge>
                    <UBadge v-if="attempt.result_kind === 'platform_error'" color="warning" variant="subtle">平台错误</UBadge>
                    <UBadge v-if="attempt.state === 'superseded'" color="neutral" variant="subtle">已被取代</UBadge>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 测试点明细（挪到提交代码上方） -->
      <details v-if="submission.result?.metering" class="rounded-md border border-border bg-white p-4 text-sm">
        <summary class="cursor-pointer font-semibold">{{ submission.result.metering.legacy ? '旧计量结果，详情如下' : `本题使用 ${submission.result.metering.standard_version || '统一 WASM'} 标准评测，详情如下` }}</summary>
        <p v-if="submission.result.metering.legacy" class="mt-2 text-text-secondary">旧计量结果：无统一 WASM 标识，不能用于跨实例比较；请重测以获得新结果。</p>
        <template v-else>
          <p class="mt-2">{{ submission.result.metering.standard_version }} · {{ submission.result.metering.comparable ? '具备可比标识' : '评测环境异常，不具备可比性' }}</p>
          <p v-if="submission.result.metering.termination_reason === 'host_watchdog'" class="mt-2 text-error-text">运行保护超时，请降低负载后重测。</p>
          <p v-if="submission.result.metering.termination_reason === 'standard_mismatch'" class="mt-2 text-error-text">任务标准不匹配，请重测。</p>
          <p class="mt-1 text-xs text-text-secondary">{{ meteringTimeLabel }}表示固定工作量，不保证等于实际 CPU 耗时。可比标识不代表来源可信。</p>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            <template v-for="(label, key) in { standard_hash: '标准摘要', source_hash: '源码摘要', evaluation_hash: '题目评测摘要', module_hash: '编译产物摘要', comparison_hash: '可比标识' }" :key="key">
              <dt>{{ label }}</dt><dd class="break-all font-mono">{{ submission.result.metering[key] ?? '未生成' }}</dd>
            </template>
          </dl>
          <div v-if="meteringCases.length" class="mt-4 overflow-x-auto">
            <table class="w-full text-left text-xs">
              <caption class="mb-2 text-left font-semibold">测试点计量数据</caption>
              <thead class="border-b border-border text-text-secondary"><tr>
                <th scope="col" class="p-2">子任务</th><th scope="col" class="p-2">测试点</th><th scope="col" class="p-2">状态</th>
                <th scope="col" class="p-2 text-right">消耗 fuel</th><th scope="col" class="p-2 text-right">预算 fuel</th><th scope="col" class="p-2 text-right">{{ meteringTimeLabel }}（ms）</th>
              </tr></thead>
              <tbody><tr v-for="(item, index) in meteringCases" :key="index" class="border-b border-border">
                <td class="p-2">{{ item.subtask }}</td><td class="p-2 font-mono">{{ item.caseId }}</td><td class="p-2">{{ item.status }}</td>
                <td class="p-2 text-right tabular-nums">{{ item.fuel?.toLocaleString() ?? '—' }}</td>
                <td class="p-2 text-right tabular-nums">{{ item.budget?.toLocaleString() ?? '—' }}</td>
                <td class="p-2 text-right tabular-nums">{{ item.equivalentTimeMs ?? '—' }}</td>
              </tr></tbody>
            </table>
          </div>
        </template>
      </details>

      <!-- 各版本当前判定（跨版本保留）：换版/重测后旧版本的判定仍然可查 -->
      <section
        v-if="versionResults.length > 0"
        class="rounded-xl border border-border bg-white p-4"
      >
        <h2 class="text-sm font-semibold text-text">各版本当前判定</h2>
        <p class="mt-1 text-xs text-text-muted">
          与「尝试历史」（每次执行一条）不同：这里每个题目版本只保留<strong>最近一次完成的正式判定</strong>，
          重测只替换该版本的判定，不影响其他版本；平台错误不替换已有判定。
        </p>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-border text-text-secondary">
              <tr>
                <th scope="col" class="p-2 text-left">版本</th>
                <th scope="col" class="p-2 text-left">状态</th>
                <th scope="col" class="p-2 text-right">分数</th>
                <th scope="col" class="p-2 text-right">耗时</th>
                <th scope="col" class="p-2 text-right">内存</th>
                <th scope="col" class="p-2 text-left">标记</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in versionResults" :key="item.attempt_id" class="border-b border-border">
                <td class="p-2 font-mono">
                  {{ item.version != null ? `v${item.version}` : '未知历史版本' }}
                </td>
                <td class="p-2">{{ resultLabels[item.status] ?? item.status }}</td>
                <td class="p-2 text-right tabular-nums">{{ formatScore(item.score) }}</td>
                <td class="p-2 text-right tabular-nums">{{ formatTime(item.time_ms) }}</td>
                <td class="p-2 text-right tabular-nums">{{ formatMemory(item.memory_kb) }}</td>
                <td class="p-2">
                  <span class="flex flex-wrap gap-1.5">
                    <UBadge v-if="item.is_effective" color="primary" variant="subtle">有效成绩</UBadge>
                    <UBadge v-if="item.is_accepted" color="success" variant="subtle">通过</UBadge>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <SubmissionCaseResults
        v-if="submission.progress || submission.result"
        :details="submission.result?.details"
        :progress="['pending','judging'].includes(submission.status) ? submission.progress : null"
      />
      <!-- 提交代码 -->
      <div class="bg-[#0d1117] border border-[#30363d] rounded-xl overflow-hidden">
        <button
          class="flex items-center justify-between w-full px-4 py-3 bg-[#161b22] text-[#8b949e] text-xs font-mono border-b border-[#30363d] cursor-pointer hover:bg-[#1c2128]"
          @click="showCode = !showCode"
        >
          <span class="flex items-center gap-2">
            <UIcon name="i-lucide-file-text" class="size-4" />
            <span>{{ submission.language === 'ui' ? '提交参数' : '提交代码' }}</span>
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
