<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue'
import type { WorkspaceProblem, WorkspaceSubmission } from '~/components/editor/EditorWorkspace.vue'
import { extractApiError } from '~/utils/apiError'
import { getStatusColor, getStatusLabel } from '~/utils/submissionFormat'
import { diffLines } from '~/utils/textDiff'
import { parseValues, stableStringify, type UiFrameResult } from '~/utils/uiFrame'
import UiFrame from '~/components/uiproblem/UiFrame.vue'
import { useDraftStorage } from '~/composables/useDraftStorage'
import { useSubmissionPolling } from '~/composables/useSubmissionPolling'
import { useSelfTestPolling } from '~/composables/useSelfTestPolling'
import { useToast } from '~/composables/useToast'

/**
 * 界面题做题界面（`submission_mode = "ui"`）。
 *
 * 由 pages/editor/[id].vue 按提交模式选择：左侧题面，右侧渲染题包自带的 `ui.html`
 * （沙箱 iframe，见 UiFrame）+ 运行历史。界面收集的参数以稳定排序的 JSON 文本作为
 * "提交内容"，提交语言固定为 `ui`；core 把参数注入出题人的脚本模板后交给 judge 运行。
 *
 * 运行历史：每一轮提交 / 自测的参数都由服务端随记录保存（submissions.code /
 * self_tests.code），这里合并展示两类记录，支持与当前参数逐行对比并一键回滚；
 * 回滚后可撤销（仅在回滚后未再编辑时可用，避免覆盖新输入），回滚会通过 `NOJ.onSet`
 * 通知界面刷新控件。
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
    /** 本人自测列表地址（竞赛模式无自测，不传）。 */
    selfTestHistoryUrl?: string
    /** 界面题的 ui.html 接口地址。 */
    uiUrl: string
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
    selfTestHistoryUrl: undefined,
    backLabel: '返回',
    subtitle: '',
    canSubmit: true,
    submissionFilter: undefined,
  },
)

const emit = defineEmits<{ accepted: [] }>()

/** 提交语言（与 core 的 UI_LANGUAGE 一致）。 */
const UI_LANGUAGE = 'ui'
/** 与 core 路由层 MAX_CODE_LENGTH 一致（100KB 字符）。 */
const MAX_PARAMS_LENGTH = 100 * 1024
const noun = '参数'

const router = useRouter()
const { isLoggedIn } = useAuth()
const { api } = useApi()
const { toast } = useToast()

// ── 参数内容与草稿：参数以稳定排序的 JSON 文本保存（草稿、运行历史、对比与回滚都按此文本） ──
const paramsText = ref('')
const draftEnabled = ref(true)
const { state: draftState, savedAt: draftSavedAt } = useDraftStorage(
  computed(() => props.draftKey),
  paramsText,
  draftEnabled,
)

const charCount = computed(() => paramsText.value.length)
const overLimit = computed(() => charCount.value > MAX_PARAMS_LENGTH)

// ── 加载 ui.html；界面参数与 paramsText 双向同步 ──
const uiHtml = ref('')
const uiLoading = ref(false)
const uiError = ref('')

async function loadUi() {
  if (!props.uiUrl) return
  uiLoading.value = true
  uiError.value = ''
  try {
    const res = await api.get<{ data: { html: string } }>(props.uiUrl, { silent: true })
    uiHtml.value = res?.data?.html ?? ''
    if (!uiHtml.value) uiError.value = '该题目没有提供界面文件'
  } catch (e: unknown) {
    uiError.value = extractApiError(e).message
  } finally {
    uiLoading.value = false
  }
}
watch(() => props.uiUrl, loadUi, { immediate: true })

/** 当前参数：由 paramsText（JSON）解析；非法文本视为空（界面会被推送空参数）。 */
const uiValues = computed(() => parseValues(paramsText.value))

function onUiValues(values: Record<string, unknown>) {
  paramsText.value = stableStringify(values)
}

/** 推送给界面的最近一次运行状态（自测/提交取较新者）。 */
const frameResult = computed<UiFrameResult | null>(() => {
  const sub = activeSubmission.value
  const st = activeSelfTest.value
  const useSelfTest = st && (!sub || st.created_at >= sub.created_at)
  if (useSelfTest && st) {
    return {
      kind: 'self-test',
      status: st.status,
      label: getStatusLabel(st.status, st.result_status ?? undefined),
      score: st.status === 'finished' ? st.score / 100 : null,
      output: st.output ? st.output.slice(0, 4000) : null,
    }
  }
  if (sub) {
    return {
      kind: 'submit',
      status: sub.status,
      label: getStatusLabel(sub.status, sub.result?.status),
      score: sub.status === 'finished' && sub.result ? sub.result.score / 100 : null,
    }
  }
  return null
})

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
  return snapshots.get(row.key) === paramsText.value
}

async function togglePreview(row: RunRow) {
  if (expandedKey.value === row.key) {
    expandedKey.value = null
    return
  }
  const text = await loadSnapshot(row)
  if (text === null) {
    toast.error(`无法获取该轮的${noun}`)
    return
  }
  expandedKey.value = row.key
}

/** 预览：历史版本 → 当前编辑内容 的行级差异（"回滚"会把右侧变回左侧）。 */
const expandedDiff = computed(() => {
  const key = expandedKey.value
  if (!key) return []
  const snapshot = snapshots.get(key)
  return snapshot === undefined ? [] : diffLines(snapshot, paramsText.value)
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
    toast.error(`无法获取该轮的${noun}`)
    return
  }
  if (text === paramsText.value) {
    toast.info(`当前${noun}已与该轮一致`)
    return
  }
  rollbackState.value = { previous: paramsText.value, applied: text, label: runLabel(row) }
  paramsText.value = text
  expandedKey.value = null
  toast.success(`已回滚到「${runLabel(row)}」的${noun}`)
}

function undoRollback() {
  const state = rollbackState.value
  if (!state) return
  paramsText.value = state.previous
  rollbackState.value = null
}

// 回滚后一旦继续编辑，撤销就会丢失新输入，因此不再提供撤销
watch(paramsText, (v) => {
  if (rollbackState.value && v !== rollbackState.value.applied) rollbackState.value = null
})

// ── 提交 / 自测 ──
const submitting = ref(false)
const selfTesting = ref(false)
const actionError = ref('')
const canEdit = computed(() => isLoggedIn.value && props.canSubmit)
const hasContent = computed(() => Object.keys(uiValues.value).length > 0)
const canSubmitNow = computed(() => canEdit.value && hasContent.value && !overLimit.value)
const canSelfTestNow = computed(() => hasSelfTest.value && isLoggedIn.value && hasContent.value && !overLimit.value)

function precheck(): boolean {
  if (!isLoggedIn.value) {
    actionError.value = '请先登录'
    return false
  }
  if (!hasContent.value) {
    actionError.value = '请先填写参数'
    return false
  }
  if (overLimit.value) {
    actionError.value = `${noun}超过 ${MAX_PARAMS_LENGTH} 字符上限，请精简后再提交`
    return false
  }
  return true
}

async function handleSubmit() {
  if (!props.problem || !precheck()) return
  submitting.value = true
  actionError.value = ''
  try {
    const submitted = paramsText.value
    const res = await props.submit(props.problem.id, UI_LANGUAGE, submitted)
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
    const tested = paramsText.value
    const res = await props.selfTest(props.problem.id, UI_LANGUAGE, tested)
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

async function copyParams() {
  try {
    await navigator.clipboard.writeText(paramsText.value)
    toast.success(`${noun}已复制`)
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
                <UIcon name="i-lucide-layout-dashboard" class="size-3" />界面题
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
                  <UIcon name="i-lucide-layout-dashboard" class="size-3.5" />题目界面
                </span>

                <div class="ml-auto flex items-center gap-1">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-copy"
                    :disabled="!hasContent"
                    @click="copyParams"
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
                已回滚到「{{ rollbackState.label }}」的{{ noun }}
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

              <!-- 渲染题包自带的 ui.html（沙箱 iframe） -->
              <div class="relative min-h-0 flex-1">
                <div v-if="uiLoading" class="flex h-full items-center justify-center text-xs text-text-muted">加载界面...</div>
                <div v-else-if="uiError" class="flex h-full flex-col items-center justify-center gap-2 text-xs text-text-muted">
                  <span class="text-red-600">{{ uiError }}</span>
                  <UButton color="neutral" variant="outline" size="xs" icon="i-lucide-rotate-cw" @click="loadUi">重试</UButton>
                </div>
                <UiFrame
                  v-else
                  :html="uiHtml"
                  :values="uiValues"
                  :disabled="!canEdit || submitting"
                  :result="frameResult"
                  :title="problem.title"
                  @update:values="onUiValues"
                  @submit="handleSubmit"
                  @self-test="handleSelfTest"
                />
              </div>


              <div class="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-text-muted tabular-nums">
                <span>{{ Object.keys(uiValues).length }} 个字段</span>
                <span :class="{ 'font-semibold text-red-600': overLimit }">{{ charCount }} / {{ MAX_PARAMS_LENGTH }} 字符</span>
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
                  还没有运行记录。每次自测或提交的{{ noun }}都会保存在这里，可随时回滚
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
                          :disabled="row.language !== UI_LANGUAGE"
                          @click="togglePreview(row)"
                        >
                          {{ expandedKey === row.key ? '收起' : '对比' }}
                        </UButton>
                        <UButton
                          color="primary"
                          variant="soft"
                          size="xs"
                          icon="i-lucide-undo-2"
                          :disabled="!canEdit || row.language !== UI_LANGUAGE || isCurrentVersion(row)"
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
                  自测会用当前{{ noun }}完整跑一次评测，不计入正式提交
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
