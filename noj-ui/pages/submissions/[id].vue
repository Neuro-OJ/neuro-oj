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

const { data, refresh } = useFetch<SubmissionResponse>(
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

// 自动轮询 pending/judging 状态
let pollTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => submission.value?.status,
  (status) => {
    if (status === "pending" || status === "judging") {
      pollTimer = setInterval(() => refresh(), 3000)
    } else {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
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
  <div class="result-page">
    <!-- 回退链接 -->
    <NuxtLink
      v-if="submission"
      :to="`/problems/${submission.problem_id}`"
      class="back-link"
    >
      <ArrowLeft :size="16" />
      返回题目
    </NuxtLink>

    <!-- Loading -->
    <div v-if="!submission" class="loading-state">
      <div class="spinner" />
      <span>加载中...</span>
    </div>

    <template v-else>
      <!-- 头部卡片 -->
      <div class="result-card">
        <div class="result-header">
          <h1 class="result-title">提交结果</h1>
          <span class="submission-id">#{{ submission.id.slice(0, 8) }}</span>
        </div>

        <div class="result-badge-area">
          <!-- 等待/评测中 -->
          <div
            v-if="submission.status === 'pending'"
            class="status-badge pending"
          >
            <Loader2 :size="20" class="spin-icon" />
            <span>等待评测</span>
          </div>

          <div
            v-else-if="submission.status === 'judging'"
            class="status-badge judging"
          >
            <Loader2 :size="20" class="spin-icon" />
            <span>评测中</span>
          </div>

          <div
            v-else-if="submission.status === 'error'"
            class="status-badge error"
          >
            <XCircle :size="22" />
            <span>系统错误</span>
          </div>

          <!-- 已完成 -->
          <div
            v-else-if="submission.result"
            class="result-verdict"
            :class="getResultDef(submission.result.status).class"
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
            <div class="verdict-text">
              <span class="verdict-label">
                {{ getResultDef(submission.result.status).label }}
              </span>
              <span class="verdict-score">
                {{ formatScore(submission.result.score) }} 分
              </span>
            </div>
          </div>
        </div>

        <!-- 元信息 -->
        <div class="result-meta">
          <div class="meta-row">
            <span class="meta-label">题目</span>
            <NuxtLink
              :to="`/problems/${submission.problem_id}`"
              class="meta-value link"
            >
              {{ submission.problem_id }}
            </NuxtLink>
          </div>
          <div class="meta-row">
            <span class="meta-label">语言</span>
            <span class="meta-value">
              {{ languageLabel[submission.language] || submission.language }}
            </span>
          </div>
          <div class="meta-row">
            <span class="meta-label">提交时间</span>
            <span class="meta-value">
              {{ formatDateTime(submission.created_at) }}
            </span>
          </div>
        </div>

        <!-- 资源消耗（仅 finished） -->
        <div
          v-if="submission.result && submission.status === 'finished'"
          class="resource-row"
        >
          <div class="resource-item">
            <Clock :size="16" />
            <div class="resource-info">
              <span class="resource-label">耗时</span>
              <span class="resource-value">
                {{ formatTime(submission.result.time_ms) }}
              </span>
            </div>
          </div>
          <div class="resource-item">
            <Server :size="16" />
            <div class="resource-info">
              <span class="resource-label">内存</span>
              <span class="resource-value">
                {{ formatMemory(submission.result.memory_kb) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 代码区 -->
      <div class="code-card">
        <div class="code-card-header">
          <FileText :size="16" />
          <span>{{ submission.file_name || "main.py" }}</span>
        </div>
        <pre class="code-body"><code :ref="codeRef" :class="`language-${codeLanguage}`">{{ submission.code }}</code></pre>
      </div>

      <!-- 输出区（仅 finished 有内容） -->
      <div
        v-if="submission.status === 'finished' && submission.result?.output"
        class="output-card"
      >
        <button
          class="output-header"
          @click="showOutput = !showOutput"
        >
          <span>评测输出</span>
          <ChevronDown v-if="!showOutput" :size="16" />
          <ChevronUp v-else :size="16" />
        </button>
        <pre v-show="showOutput" class="output-body"><code>{{ submission.result.output }}</code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.result-page {
  max-width: 800px;
  margin: 0 auto;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ── Back Link ── */
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--c-text-secondary);
  text-decoration: none;
}

.back-link:hover {
  color: var(--c-primary);
}

/* ── Loading ── */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 24px;
  color: var(--c-text-muted);
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--c-border);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Result Card ── */
.result-card {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  overflow: hidden;
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.result-title {
  font-size: 18px;
  font-weight: 700;
}

.submission-id {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 13px;
  color: var(--c-text-muted);
}

/* ── Badge / Verdict ── */
.result-badge-area {
  padding: 28px 24px;
  display: flex;
  justify-content: center;
}

.status-badge {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 28px;
  border-radius: 40px;
  font-size: 16px;
  font-weight: 600;
}

.status-badge.pending {
  background: #f8fafc;
  color: #64748b;
  border: 1px solid var(--c-border);
}

.status-badge.judging {
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.status-badge.error {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
}

.spin-icon {
  animation: spin 1s linear infinite;
}

.result-verdict {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 36px;
  border-radius: 16px;
}

.result-verdict.accepted {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
}

.result-verdict.wrong {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.result-verdict.tle,
.result-verdict.mle {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
}

.result-verdict.re,
.result-verdict.se {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.verdict-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.verdict-label {
  font-size: 18px;
  font-weight: 700;
}

.verdict-score {
  font-size: 22px;
  font-weight: 800;
}

/* ── Meta ── */
.result-meta {
  padding: 0 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-row {
  display: flex;
  gap: 12px;
  font-size: 14px;
}

.meta-label {
  color: var(--c-text-muted);
  min-width: 70px;
  flex-shrink: 0;
}

.meta-value {
  color: var(--c-text);
}

.meta-value.link {
  color: var(--c-primary);
  text-decoration: none;
}

.meta-value.link:hover {
  text-decoration: underline;
}

/* ── Resource ── */
.resource-row {
  display: flex;
  gap: 32px;
  padding: 16px 24px;
  border-top: 1px solid var(--c-border);
  background: #f8fafc;
}

.resource-item {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--c-text-secondary);
}

.resource-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.resource-label {
  font-size: 11px;
  color: var(--c-text-muted);
}

.resource-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
}

/* ── Code Card ── */
.code-card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 12px;
  overflow: hidden;
}

.code-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #161b22;
  color: #8b949e;
  font-size: 13px;
  font-family: "SF Mono", "Fira Code", monospace;
  border-bottom: 1px solid #30363d;
}

.code-body {
  padding: 16px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
}

.code-body code {
  font-family: "SF Mono", "Fira Code", monospace;
  color: #e6edf3;
  white-space: pre;
}

/* ── Output Card ── */
.output-card {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  overflow: hidden;
}

.output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 16px;
  background: #f8fafc;
  border: none;
  border-bottom: 1px solid var(--c-border);
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
  cursor: pointer;
}

.output-header:hover {
  background: #f1f5f9;
}

.output-body {
  padding: 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  background: #0d1117;
  color: #e6edf3;
}

.output-body code {
  font-family: "SF Mono", "Fira Code", monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .result-page {
    padding: 20px 12px;
  }

  .result-verdict {
    flex-direction: column;
    text-align: center;
  }

  .resource-row {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
