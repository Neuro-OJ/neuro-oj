<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue'
import type { WorkspaceProblem, WorkspaceSubmission } from '~/components/editor/EditorWorkspace.vue'
import { extractApiError } from '~/utils/apiError'
import { restoreCodeTemplate } from '~/utils/codeEditorTemplate'
import { getStatusColor, getStatusLabel } from '~/utils/submissionFormat'
import { diffLines, insertAtSelection, summarizePlaceholders } from '~/utils/promptPlaceholders'
import { useDraftStorage } from '~/composables/useDraftStorage'
import { useSubmissionPolling } from '~/composables/useSubmissionPolling'
import { useSelfTestPolling } from '~/composables/useSelfTestPolling'
import { useDialog } from '~/composables/useDialog'
import { useToast } from '~/composables/useToast'

/**
 * 提示词题做题界面（`submission_mode = "prompt"`）。
 *
 * 与代码工作区（EditorWorkspace）并列，由 pages/editor/[id].vue 按提交模式选择：
 * 左侧题面，右侧提示词编辑器 + 运行历史。提交语言固定为 `prompt`，
 * core 侧负责把提示词包装为 Solution 模块。
 *
 * 运行历史：每一轮提交 / 自测的提示词都由服务端随记录保存（submissions.code /
 * self_tests.code），这里合并展示两类记录，支持预览与当前内容的差异并一键回滚；
 * 回滚后可撤销（仅在回滚后未再编辑时可用，避免覆盖新输入）。
 *
 * 数据源与 EditorWorkspace 相同的注入式 props（标准题库 / 竞赛共用）。
 */
const props = withDefaults(
  defineProps<{
    problem: WorkspaceProblem | null
    pending: boolean
    error: unknown
    retry: () => void
    historyUrl: string | (() => string)
    submit: (problemId: string, language: string, code: string) => Promise<{ id: string }>
    selfTest?: (problemId: string, language: string, code: string) => Promise<{ id: string }>
    templateUrl?: (problemId: string) => string
    /** 本人自测列表地址（竞赛模式无自测，不传）。 */
    selfTestHistoryUrl?: string
    draftKey: string
    openSubmissionUrl: (id: string) => string
    backUrl: string
    backLabel?: string
    subtitle?: string
    canSubmit?: boolean
    submissionFilter?: (s: WorkspaceSubmission) => boolean
  }>(),
  {
    selfTest: undefined,
    templateUrl: undefined,
    selfTestHistoryUrl: undefined,
    backLabel: '返回',
    subtitle: '',
    canSubmit: true,
    submissionFilter: undefined,
  },
)

const emit = defineEmits<{ accepted: [] }>()

/** 提示词提交语言（与 core 的 PROMPT_LANGUAGE 一致）。 */
const PROMPT_LANGUAGE = 'prompt'
/** 与 core 路由层 MAX_CODE_LENGTH 一致（100KB 字符）。 */
const MAX_PROMPT_LENGTH = 100 * 1024

const router = useRouter()
const { isLoggedIn } = useAuth()
const { api } = useApi()
const { dialog } = useDialog()
const { toast } = useToast()

// ── 提示词内容与草稿 ──
const prompt = ref('')
const draftEnabled = ref(true)
const { state: draftState, savedAt: draftSavedAt, clear: clearDraft } = useDraftStorage(
  computed(() => props.draftKey),
  prompt,
  draftEnabled,
)

const textareaComp = useTemplateRef<{ textareaRef: HTMLTextAreaElement | null }>('textareaComp')

const charCount = computed(() => prompt.value.length)
const lineCount = computed(() => (prompt.value ? prompt.value.split('\n').length : 0))
const overLimit = computed(() => charCount.value > MAX_PROMPT_LENGTH)

// ── 占位符：题面以行内代码声明，提示词中实际使用 ──
const placeholders = computed(() =>
  summarizePlaceholders(props.problem?.description ?? '', prompt.value),
)
const missingCount = computed(() => placeholders.value.filter((p) => p.state === 'missing').length)

/** 占位符展示文本；放在脚本里，避免模板插值中出现 `}}` 被提前截断。 */
function placeholderText(name: string) {
  return `{${name}}`
}

async function insertPlaceholder(name: string) {
  const el = textareaComp.value?.textareaRef
  const start = el?.selectionStart ?? prompt.value.length
  const end = el?.selectionEnd ?? prompt.value.length
  const res = insertAtSelection(prompt.value, start, end, placeholderText(name))
  prompt.value = res.text
  await nextTick()
  el?.focus()
  el?.setSelectionRange(res.cursor, res.cursor)
}

// ── 时间显示 ──
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (clock) clearInterval(clock)
})

const draftLabel = computed(() => {
  if (!draftSavedAt.value) return '未保存'
  const diff = Math.floor((now.value - draftSavedAt.value.getTime()) / 1000)
  if (diff < 2) return '刚刚已保存'
  if (diff < 60) return `${diff}s 前已保存`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前已保存`
  return `${draftSavedAt.value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已保存`
})
const draftDotClass = computed(() => {
  switch (draftState.value) {
    case 'dirty': return 'bg-orange-500'
    case 'saving': return 'bg-blue-500 animate-pulse'
    case 'error': return 'bg-red-500'
    case 'saved': return 'bg-green-500'
    default: return 'bg-text-muted'
  }
})

function formatAgo(iso: string) {
  const diff = Math.floor((now.value - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${Math.max(diff, 0)}s 前`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function formatScore(s: number | null | undefined) {
  return s == null ? '—' : (s / 100).toFixed(0)
}

// ── 提交历史与轮询 ──
const { data: submissionsData, refresh: refreshSubmissions } = useFetch<{ data: WorkspaceSubmission[] }>(
  () => (typeof props.historyUrl === 'function' ? props.historyUrl() : props.historyUrl),
  { server: false, default: () => ({ data: [] }) },
)
const submissions = computed(() => {
  const all = submissionsData.value?.data ?? []
  return props.submissionFilter ? all.filter(props.submissionFilter) : all
})

const activeSubmissionId = ref<string | null>(null)
const { submission: activeSubmission, isPolling: isPollingSubmission, start: startPolling } =
  useSubmissionPolling(activeSubmissionId)

watch(activeSubmission, (s) => {
  if (s?.status === 'finished' && s.result?.status === 'finished' && (s.result?.score ?? 0) > 0) {
    emit('accepted')
  }
  if (s && (s.status === 'finished' || s.status === 'error')) refreshSubmissions()
})

const activeSelfTestId = ref<string | null>(null)
const {
  selfTest: activeSelfTest,
  isPolling: isPollingSelfTest,
  error: selfTestPollError,
  start: startSelfTestPolling,
} = useSelfTestPolling(activeSelfTestId)

watch(activeSelfTest, (t) => {
  if (t && (t.status === 'finished' || t.status === 'error')) refreshSelfTests()
})

type ResultTab = 'history' | 'self-test'
const resultTab = ref<ResultTab>('history')
const hasSelfTest = computed(() => !!props.selfTest)
const resultTabs = computed(() => [
  { label: '运行历史', value: 'history', icon: 'i-lucide-history' },
  ...(hasSelfTest.value ? [{ label: '自测输出', value: 'self-test', icon: 'i-lucide-flask-conical' }] : []),
])

// ── 运行历史：合并提交与自测 ──
interface SelfTestSummary {
  id: string
  language: string
  status: string
  result_status: string | null
  score: number
  created_at: string
}

const selfTestRuns = ref<SelfTestSummary[]>([])
async function refreshSelfTests() {
  if (!props.selfTestHistoryUrl || !isLoggedIn.value) return
  try {
    const res = await api.get<{ data: SelfTestSummary[] }>(props.selfTestHistoryUrl, { silent: true })
    selfTestRuns.value = res?.data ?? []
  } catch {
    // 历史加载失败不影响编辑与提交
  }
}
watch(() => props.selfTestHistoryUrl, refreshSelfTests, { immediate: true })

type RunKind = 'submit' | 'self-test'
interface RunRow {
  key: string
  kind: RunKind
  id: string
  language: string
  status: string
  resultStatus?: string | null
  score: number | null
  createdAt: string
}

const runRows = computed<RunRow[]>(() => {
  const rows = new Map<string, RunRow>()
  for (const s of submissions.value.slice(0, 30)) {
    rows.set(`submit:${s.id}`, {
      key: `submit:${s.id}`,
      kind: 'submit',
      id: s.id,
      language: s.language,
      status: s.status,
      resultStatus: s.result?.status,
      score: s.result?.score ?? null,
      createdAt: s.created_at,
    })
  }
  for (const t of selfTestRuns.value) {
    rows.set(`self-test:${t.id}`, {
      key: `self-test:${t.id}`,
      kind: 'self-test',
      id: t.id,
      language: t.language,
      status: t.status,
      resultStatus: t.result_status,
      score: t.score,
      createdAt: t.created_at,
    })
  }
  // 正在轮询的记录用最新状态覆盖（列表接口可能尚未刷新）
  const sub = activeSubmission.value
  if (sub) {
    rows.set(`submit:${sub.id}`, {
      key: `submit:${sub.id}`,
      kind: 'submit',
      id: sub.id,
      language: sub.language,
      status: sub.status,
      resultStatus: sub.result?.status,
      score: sub.result?.score ?? null,
      createdAt: sub.created_at,
    })
  }
  const st = activeSelfTest.value
  if (st) {
    rows.set(`self-test:${st.id}`, {
      key: `self-test:${st.id}`,
      kind: 'self-test',
      id: st.id,
      language: st.language,
      status: st.status,
      resultStatus: st.result_status,
      score: st.score,
      createdAt: st.created_at,
    })
  }
  return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

/** 每轮运行的提示词快照（key = kind:id）；本页发起的运行在提交时即写入，其余按需拉取。 */
const snapshots = reactive(new Map<string, string>())
const loadingKey = ref<string | null>(null)
const expandedKey = ref<string | null>(null)

async function loadSnapshot(row: RunRow): Promise<string | null> {
  const cached = snapshots.get(row.key)
  if (cached !== undefined) return cached
  loadingKey.value = row.key
  try {
    const url = row.kind === 'submit' ? `/api/v1/submissions/${row.id}` : `/api/v1/self-tests/${row.id}`
    const res = await api.get<{ data: { code?: string | null } }>(url, { silent: true })
    const code = res?.data?.code
    if (typeof code !== 'string') return null
    snapshots.set(row.key, code)
    return code
  } catch {
    return null
  } finally {
    loadingKey.value = null
  }
}

function isCurrentVersion(row: RunRow) {
  return snapshots.get(row.key) === prompt.value
}

async function togglePreview(row: RunRow) {
  if (expandedKey.value === row.key) {
    expandedKey.value = null
    return
  }
  const text = await loadSnapshot(row)
  if (text === null) {
    toast.error('无法获取该轮的提示词')
    return
  }
  expandedKey.value = row.key
}

/** 预览：历史版本 → 当前编辑内容 的行级差异（"回滚"会把右侧变回左侧）。 */
const expandedDiff = computed(() => {
  const key = expandedKey.value
  if (!key) return []
  const snapshot = snapshots.get(key)
  return snapshot === undefined ? [] : diffLines(snapshot, prompt.value)
})

function runLabel(row: RunRow) {
  const time = new Date(row.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${row.kind === 'submit' ? '提交' : '自测'} · ${time}`
}

/** 最近一次回滚：保留回滚前内容以便撤销。 */
const rollbackState = ref<{ previous: string; applied: string; label: string } | null>(null)

async function rollback(row: RunRow) {
  if (!canEdit.value) return
  const text = await loadSnapshot(row)
  if (text === null) {
    toast.error('无法获取该轮的提示词')
    return
  }
  if (text === prompt.value) {
    toast.info('当前提示词已与该轮一致')
    return
  }
  rollbackState.value = { previous: prompt.value, applied: text, label: runLabel(row) }
  prompt.value = text
  expandedKey.value = null
  toast.success(`已回滚到「${runLabel(row)}」的提示词`)
}

function undoRollback() {
  const state = rollbackState.value
  if (!state) return
  prompt.value = state.previous
  rollbackState.value = null
}

// 回滚后一旦继续编辑，撤销就会丢失新输入，因此不再提供撤销
watch(prompt, (v) => {
  if (rollbackState.value && v !== rollbackState.value.applied) rollbackState.value = null
})

// ── 提交 / 自测 ──
const submitting = ref(false)
const selfTesting = ref(false)
const actionError = ref('')
const canEdit = computed(() => isLoggedIn.value && props.canSubmit)
const hasContent = computed(() => prompt.value.trim().length > 0)
const canSubmitNow = computed(() => canEdit.value && hasContent.value && !overLimit.value)
const canSelfTestNow = computed(() => hasSelfTest.value && isLoggedIn.value && hasContent.value && !overLimit.value)

function precheck(): boolean {
  if (!isLoggedIn.value) {
    actionError.value = '请先登录'
    return false
  }
  if (!hasContent.value) {
    actionError.value = '请先编写提示词'
    return false
  }
  if (overLimit.value) {
    actionError.value = `提示词超过 ${MAX_PROMPT_LENGTH} 字符上限，请精简后再提交`
    return false
  }
  return true
}

async function handleSubmit() {
  if (!props.problem || !precheck()) return
  submitting.value = true
  actionError.value = ''
  try {
    const submitted = prompt.value
    const res = await props.submit(props.problem.id, PROMPT_LANGUAGE, submitted)
    snapshots.set(`submit:${res.id}`, submitted)
    resultTab.value = 'history'
    startPolling(res.id)
    setTimeout(() => refreshSubmissions(), 2000)
  } catch (err: unknown) {
    actionError.value = extractApiError(err).message
  } finally {
    submitting.value = false
  }
}

async function handleSelfTest() {
  if (!props.problem || !props.selfTest || !precheck()) return
  selfTesting.value = true
  actionError.value = ''
  try {
    const tested = prompt.value
    const res = await props.selfTest(props.problem.id, PROMPT_LANGUAGE, tested)
    snapshots.set(`self-test:${res.id}`, tested)
    resultTab.value = 'self-test'
    startSelfTestPolling(res.id)
    refreshSelfTests()
  } catch (err: unknown) {
    actionError.value = extractApiError(err).message
  } finally {
    selfTesting.value = false
  }
}

/** Ctrl/Cmd + Enter：有自测时运行自测，否则提交评测。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  if (hasSelfTest.value) handleSelfTest()
  else handleSubmit()
}

// ── 模板（提示词初稿） ──
const templateLoading = ref(false)

async function fetchTemplate(problemId: string): Promise<string | null> {
  if (!props.templateUrl) return null
  const res = await api.get<{ data: { content: string } }>(props.templateUrl(problemId), { silent: true })
  return res?.data?.content || null
}

watch(
  () => props.problem,
  async (p) => {
    if (!p || !props.templateUrl) return
    // 等 useDraftStorage 完成 localStorage 恢复，已有草稿则不覆盖
    await nextTick()
    await nextTick()
    if (prompt.value.trim() !== '') return
    if (draftState.value === 'saved' || draftState.value === 'dirty' || draftState.value === 'saving') return
    templateLoading.value = true
    try {
      const tpl = await fetchTemplate(p.id)
      if (tpl && prompt.value.trim() === '') prompt.value = tpl
    } catch {
      // 404 = 无初稿，其余错误不阻塞编写
    } finally {
      templateLoading.value = false
    }
  },
  { immediate: true },
)

async function resetTemplate() {
  if (!props.problem || !props.templateUrl || templateLoading.value) return
  const confirmed = await dialog.confirm('这将用题目提供的初稿覆盖当前提示词，并清除本地草稿，是否继续？', {
    title: '恢复初稿',
    confirmText: '恢复',
    danger: true,
  })
  if (!confirmed) return
  templateLoading.value = true
  try {
    const restored = await restoreCodeTemplate({
      fetchTemplate: () => fetchTemplate(props.problem!.id),
      clearDraft,
      setCode: (tpl) => { prompt.value = tpl },
    })
    if (restored) toast.success('已恢复为题目初稿')
    else toast.error('该题没有提供提示词初稿')
  } catch (e: unknown) {
    toast.error(`恢复失败：${extractApiError(e).message}`)
  } finally {
    templateLoading.value = false
  }
}

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(prompt.value)
    toast.success('提示词已复制')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

// ── 布局 ──
const statementVisible = ref(true)

function openSubmission(id: string) {
  router.push(props.openSubmissionUrl(id))
}
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-bg-page">
    <ClientOnly>
      <!-- 加载中 -->
      <div v-if="pending" class="flex flex-1 items-center justify-center">
        <div class="flex flex-col items-center gap-3 text-text-muted">
          <div class="size-7 animate-spin-slow rounded-full border-[3px] border-border border-t-primary" />
          <span class="text-sm">加载题目...</span>
        </div>
      </div>

      <!-- 加载失败 -->
      <div v-else-if="error || !problem" class="flex flex-1 items-center justify-center">
        <div class="flex flex-col items-center gap-3 text-text-muted">
          <span class="flex size-11 items-center justify-center rounded-full bg-red-100 text-xl font-bold text-red-800">!</span>
          <p class="text-sm">题目加载失败</p>
          <div class="flex gap-2">
            <UButton color="primary" variant="outline" size="sm" icon="i-lucide-rotate-cw" @click="retry">重试</UButton>
            <UButton color="neutral" variant="outline" size="sm" :to="backUrl">{{ backLabel }}</UButton>
          </div>
        </div>
      </div>

      <template v-else>
        <!-- 顶栏 -->
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-white px-4">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-arrow-left"
            :aria-label="backLabel"
            :title="backLabel"
            :to="backUrl"
          />
          <span
            v-if="problem.label"
            class="flex size-7 items-center justify-center rounded border border-primary/20 bg-primary-bg font-mono text-xs font-bold text-primary"
          >{{ problem.label }}</span>
          <div class="flex min-w-0 flex-col">
            <div class="flex min-w-0 items-center gap-2">
              <span class="font-mono text-xs text-text-muted">{{ problem.display_id }}</span>
              <h1 class="truncate text-sm font-semibold text-text">{{ problem.title }}</h1>
              <span class="inline-flex shrink-0 items-center gap-1 rounded bg-primary-bg px-1.5 py-0.5 text-[11px] font-medium text-primary">
                <UIcon name="i-lucide-message-square-text" class="size-3" />提示词题
              </span>
            </div>
            <span v-if="subtitle" class="truncate text-xs text-text-muted">{{ subtitle }}</span>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <slot name="toolbar-actions" />
            <div class="hidden items-center gap-1.5 text-xs text-text-secondary sm:flex" :title="draftLabel">
              <span class="size-1.5 rounded-full" :class="draftDotClass" />
              {{ draftLabel }}
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :icon="statementVisible ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
              :title="statementVisible ? '收起题面' : '展开题面'"
              :aria-label="statementVisible ? '收起题面' : '展开题面'"
              @click="statementVisible = !statementVisible"
            />
            <UButton
              v-if="hasSelfTest"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-flask-conical"
              :loading="selfTesting"
              :disabled="!canSelfTestNow"
              @click="handleSelfTest"
            >
              自测
            </UButton>
            <UButton
              color="primary"
              size="sm"
              icon="i-lucide-send"
              :loading="submitting"
              :disabled="!canSubmitNow"
              @click="handleSubmit"
            >
              提交评测
            </UButton>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 gap-4 p-4">
          <!-- 题面 -->
          <aside
            v-if="statementVisible"
            class="flex w-[38%] min-w-[280px] max-w-[560px] flex-col overflow-hidden rounded-lg border border-border bg-white"
          >
            <div class="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold text-text-secondary">
              <UIcon name="i-lucide-book-open" class="size-3.5" />题面
            </div>
            <div class="flex-1 overflow-y-auto px-5 py-4">
              <div class="prose prose-sm prose-neuro max-w-none">
                <MarkdownRenderer :content="problem.description" />
              </div>
            </div>
          </aside>

          <!-- 提示词编辑 + 结果 -->
          <main class="flex min-w-0 flex-1 flex-col gap-4">
            <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-white">
              <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <span class="inline-flex items-center gap-2 text-xs font-semibold text-text-secondary">
                  <UIcon name="i-lucide-message-square-text" class="size-3.5" />我的提示词
                </span>

                <!-- 占位符：绿色=已使用，琥珀=题面要求但缺失，灰色=自定义；点击插入到光标处 -->
                <div v-if="placeholders.length" class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[11px] text-text-muted">占位符</span>
                  <button
                    v-for="ph in placeholders"
                    :key="ph.name"
                    type="button"
                    class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-not-allowed"
                    :class="{
                      'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100': ph.state === 'used',
                      'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100': ph.state === 'missing',
                      'border-border bg-bg-page text-text-secondary hover:bg-sunken': ph.state === 'extra',
                    }"
                    :title="ph.state === 'missing' ? '题面要求但提示词中未使用，点击插入' : '点击插入到光标处'"
                    :disabled="!canEdit"
                    @click="insertPlaceholder(ph.name)"
                  >
                    <UIcon
                      :name="ph.state === 'missing' ? 'i-lucide-circle-alert' : ph.state === 'used' ? 'i-lucide-check' : 'i-lucide-braces'"
                      class="size-3"
                    />
                    {{ placeholderText(ph.name) }}
                  </button>
                </div>

                <div class="ml-auto flex items-center gap-1">
                  <UButton
                    v-if="templateUrl"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-rotate-ccw"
                    :loading="templateLoading"
                    :disabled="!canEdit"
                    @click="resetTemplate"
                  >
                    恢复初稿
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-copy"
                    :disabled="!hasContent"
                    @click="copyPrompt"
                  >
                    复制
                  </UButton>
                </div>
              </div>

              <!-- 回滚提示：回滚后未继续编辑前可撤销 -->
              <div
                v-if="rollbackState"
                class="flex items-center gap-2 border-b border-primary/20 bg-primary-bg px-4 py-1.5 text-xs text-primary"
              >
                <UIcon name="i-lucide-undo-2" class="size-3.5" />
                已回滚到「{{ rollbackState.label }}」的提示词
                <UButton color="primary" variant="link" size="xs" class="ml-auto" @click="undoRollback">撤销回滚</UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  aria-label="关闭"
                  @click="rollbackState = null"
                />
              </div>

              <UTextarea
                ref="textareaComp"
                v-model="prompt"
                :disabled="!canEdit || submitting"
                :placeholder="isLoggedIn ? '在这里编写提示词。题面中的 {占位符} 会在评测时被替换为测试输入。' : '登录后即可编写提示词'"
                variant="none"
                class="min-h-0 flex-1"
                :ui="{ root: 'flex min-h-0 flex-1', base: 'h-full min-h-0 resize-none px-5 py-4 text-[15px] leading-7 text-text' }"
                @keydown="onKeydown"
              />

              <div class="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-text-muted tabular-nums">
                <span>{{ lineCount }} 行</span>
                <span :class="{ 'font-semibold text-red-600': overLimit }">{{ charCount }} / {{ MAX_PROMPT_LENGTH }} 字符</span>
                <span v-if="missingCount" class="inline-flex items-center gap-1 text-amber-700">
                  <UIcon name="i-lucide-circle-alert" class="size-3" />缺少 {{ missingCount }} 个占位符
                </span>
                <span class="ml-auto hidden md:inline">{{ hasSelfTest ? 'Ctrl/⌘ + Enter 自测' : 'Ctrl/⌘ + Enter 提交' }}</span>
              </div>

              <UAlert
                v-if="actionError"
                color="error"
                variant="soft"
                icon="i-lucide-alert-circle"
                :title="actionError"
                class="rounded-none border-t border-red-200"
                close
                @update:open="actionError = ''"
              />
            </section>

            <!-- 运行历史 / 自测输出 -->
            <section class="flex h-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-white">
              <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <UTabs v-model="resultTab" :items="resultTabs" :content="false" size="xs" variant="link" />
                <UIcon
                  v-if="(resultTab === 'history' && isPollingSubmission) || isPollingSelfTest"
                  name="i-lucide-loader-2"
                  class="ml-auto size-3.5 animate-spin text-primary"
                />
              </div>

              <!-- 运行历史：每轮提交 / 自测的提示词，可预览差异并回滚 -->
              <div v-if="resultTab === 'history'" class="flex-1 overflow-y-auto">
                <div v-if="runRows.length === 0" class="flex h-full items-center justify-center text-xs text-text-muted">
                  还没有运行记录。每次自测或提交的提示词都会保存在这里，可随时回滚
                </div>
                <ul v-else class="divide-y divide-border">
                  <li v-for="row in runRows" :key="row.key">
                    <div class="flex items-center gap-3 px-4 py-2">
                      <span
                        class="inline-flex w-11 shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[11px] font-medium"
                        :class="row.kind === 'submit' ? 'border-primary/30 bg-primary-bg text-primary' : 'border-border bg-bg-page text-text-secondary'"
                      >{{ row.kind === 'submit' ? '提交' : '自测' }}</span>
                      <span
                        class="inline-flex w-20 shrink-0 items-center justify-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold"
                        :style="{
                          background: getStatusColor(row.status, row.resultStatus ?? undefined) + '1f',
                          color: getStatusColor(row.status, row.resultStatus ?? undefined),
                        }"
                      >
                        <UIcon
                          v-if="row.status === 'pending' || row.status === 'judging'"
                          name="i-lucide-loader-2"
                          class="size-[10px] animate-spin"
                        />
                        {{ getStatusLabel(row.status, row.resultStatus ?? undefined) }}
                      </span>
                      <span class="w-14 font-mono text-sm font-semibold text-text tabular-nums">
                        {{ row.status === 'finished' ? `${formatScore(row.score)} 分` : '—' }}
                      </span>
                      <span class="text-xs text-text-muted" :title="new Date(row.createdAt).toLocaleString('zh-CN')">
                        {{ formatAgo(row.createdAt) }}
                      </span>
                      <span
                        v-if="isCurrentVersion(row)"
                        class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                      >当前版本</span>

                      <div class="ml-auto flex items-center gap-1">
                        <UButton
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          :icon="expandedKey === row.key ? 'i-lucide-chevron-up' : 'i-lucide-eye'"
                          :loading="loadingKey === row.key"
                          :disabled="row.language !== 'prompt'"
                          @click="togglePreview(row)"
                        >
                          {{ expandedKey === row.key ? '收起' : '对比' }}
                        </UButton>
                        <UButton
                          color="primary"
                          variant="soft"
                          size="xs"
                          icon="i-lucide-undo-2"
                          :disabled="!canEdit || row.language !== 'prompt' || isCurrentVersion(row)"
                          @click="rollback(row)"
                        >
                          回滚
                        </UButton>
                        <UButton
                          v-if="row.kind === 'submit'"
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          icon="i-lucide-external-link"
                          title="提交详情"
                          aria-label="提交详情"
                          @click="openSubmission(row.id)"
                        />
                      </div>
                    </div>

                    <!-- 差异预览：- 为该轮有而当前没有的行，+ 为当前新增的行；回滚即恢复为该轮内容 -->
                    <div v-if="expandedKey === row.key" class="border-t border-border bg-bg-page px-4 py-2">
                      <p class="mb-1.5 text-[11px] text-text-muted">
                        与当前编辑内容对比：<span class="text-red-600">− 该轮内容</span> ·
                        <span class="text-emerald-700">+ 当前内容</span>
                      </p>
                      <div class="max-h-44 overflow-y-auto rounded border border-border bg-white py-1 font-mono text-xs leading-5"><template
                        v-for="(line, idx) in expandedDiff"
                        :key="idx"
                      ><div
                        class="whitespace-pre-wrap break-words px-2"
                        :class="{
                          'bg-red-50 text-red-700': line.kind === 'del',
                          'bg-emerald-50 text-emerald-800': line.kind === 'add',
                          'text-text-secondary': line.kind === 'same',
                        }"
                      >{{ line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' ' }} {{ line.text }}</div></template></div>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- 自测结果 -->
              <div v-else class="flex-1 overflow-y-auto px-4 py-3">
                <p
                  v-if="selfTestPollError"
                  class="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"
                >
                  {{ selfTestPollError }}
                </p>
                <div v-if="!activeSelfTest" class="flex h-full items-center justify-center text-xs text-text-muted">
                  自测会用当前提示词完整跑一次评测，不计入正式提交
                </div>
                <div v-else class="space-y-2">
                  <div class="flex items-center gap-3">
                    <span
                      class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold"
                      :style="{
                        background: getStatusColor(activeSelfTest.status, activeSelfTest.result_status) + '1f',
                        color: getStatusColor(activeSelfTest.status, activeSelfTest.result_status),
                      }"
                    >
                      <UIcon
                        v-if="activeSelfTest.status === 'pending' || activeSelfTest.status === 'judging'"
                        name="i-lucide-loader-2"
                        class="size-[10px] animate-spin"
                      />
                      {{ getStatusLabel(activeSelfTest.status, activeSelfTest.result_status) }}
                    </span>
                    <span class="font-mono text-sm font-semibold text-text tabular-nums">
                      {{ activeSelfTest.status === 'finished' ? `${formatScore(activeSelfTest.score)} 分` : '—' }}
                    </span>
                    <span class="text-xs text-text-muted">{{ formatAgo(activeSelfTest.created_at) }}</span>
                  </div>
                  <pre
                    v-if="activeSelfTest.output"
                    class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-page p-3 text-[11px] leading-relaxed"
                  >{{ activeSelfTest.output }}</pre>
                </div>
              </div>
            </section>
          </main>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
