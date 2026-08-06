<script setup lang="ts">
import { nextTick, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { extractApiError } from '~/utils/apiError'
import { useEditorTheme } from '~/composables/useEditorTheme'
import { useDraftStorage } from '~/composables/useDraftStorage'
import { useSubmissionPolling } from '~/composables/useSubmissionPolling'
import { useResizableSplitter } from '~/composables/useResizableSplitter'

/**
 * 独立做题工作区（从 pages/editor/[id].vue 抽出，供标准题库与竞赛共用）。
 *
 * 数据源由调用方注入：
 * - problem / pending / error / retry：题目来源（标准题库 useFetch 或竞赛专用接口）
 * - historyUrl / submit / templateUrl / draftKey / openSubmissionUrl：提交链路
 * - backUrl / backLabel / subtitle / badge：页面上下文（竞赛标题、题号徽标等）
 */
export interface WorkspaceProblem {
  id: string
  display_id: string
  label?: string
  title: string
  description: string
  difficulty: string
  type: 'U' | 'P'
  categories: { id: string; name: string; slug: string }[]
}

export interface WorkspaceSubmission {
  id: string
  status: string
  score: number
  language: string
  created_at: string
  result: {
    status: string
    score: number
    time_ms?: number
    memory_kb?: number
  } | null
  problem_id?: string
}

const props = withDefaults(
  defineProps<{
    problem: WorkspaceProblem | null
    pending: boolean
    error: unknown
    retry: () => void
    historyUrl: string | (() => string)
    submit: (
      problemId: string,
      language: string,
      code: string,
    ) => Promise<{ id: string }>
    templateUrl?: (problemId: string) => string
    draftKey: string
    openSubmissionUrl: (id: string) => string
    backUrl: string
    backLabel?: string
    subtitle?: string
    canSubmit?: boolean
    submissionFilter?: (s: WorkspaceSubmission) => boolean
  }>(),
  {
    templateUrl: undefined,
    backLabel: '返回',
    subtitle: '',
    canSubmit: true,
    submissionFilter: undefined,
  },
)

const router = useRouter()
const { isLoggedIn } = useAuth()
const { api } = useApi()

// 主题
const { theme, set: setTheme } = useEditorTheme()

// 草稿（key 由调用方提供，保证标准题库与竞赛互不覆盖）
const code = ref('')
const draftEnabled = ref(true)
const { state: draftState, savedAt: draftSavedAt, clear: clearDraft } = useDraftStorage(
  ref(props.draftKey),
  code,
  draftEnabled,
)

// 侧栏
const sidebarTab = ref<'description' | 'history' | 'settings'>('description')
const sidebarVisible = ref(true)
// 结构出 width 让它成为顶层 ref：v-model 模板用法依赖 Vue 顶层 setup 绑定
// 的自动 unwrap，对象属性访问的 ref 不会被 unwrap，会报
// "Invalid prop: type check failed for prop 'modelValue'. Expected Number, got Object"。
const { width: sidebarWidth } = useResizableSplitter('editor:sidebar:width', 320, 240, 480)

// 提交后实时轮询
const activeSubmissionId = ref<string | null>(null)
const {
  submission: activeSubmission,
  isPolling: isPollingActive,
  start: startPolling,
} = useSubmissionPolling(activeSubmissionId)

// 编辑器元数据（状态栏）
const cursor = ref({ line: 1, col: 1 })
const totalLines = computed(() => code.value.split('\n').length)
const totalChars = computed(() => code.value.length)

// 提交历史
const { data: submissionsData, refresh: refreshSubmissionsFn } = useFetch<{
  data: WorkspaceSubmission[]
}>(() => (typeof props.historyUrl === 'function' ? props.historyUrl() : props.historyUrl), {
  server: false,
  default: () => ({ data: [] }),
})
const submissions = computed(() => {
  const all = submissionsData.value?.data ?? []
  return props.submissionFilter ? all.filter(props.submissionFilter) : all
})

// 语言（仅 Python 3，多语言等待 judge 镜像就绪后启用）
const languages = [{ value: 'python3', label: 'Python 3' }]
const language = ref('python3')

// 提交
const submitting = ref(false)
const submitError = ref('')
const canSubmit = computed(() => props.canSubmit && isLoggedIn.value && code.value.trim().length > 0)

async function handleSubmit() {
  if (!props.problem) return
  if (!canSubmit.value) {
    submitError.value = isLoggedIn.value ? '请先编写代码' : '请先登录'
    return
  }
  submitting.value = true
  submitError.value = ''
  try {
    const res = await props.submit(props.problem.id, language.value, code.value)
    // 留在编辑页：自动切到历史 tab + 启动实时轮询
    sidebarTab.value = 'history'
    sidebarVisible.value = true
    startPolling(res.id)
    // 提交后延迟刷新历史列表，等评测结果写入
    setTimeout(() => refreshSubmissionsFn(), 2000)
  } catch (err: unknown) {
    submitError.value = extractApiError(err).message
  } finally {
    submitting.value = false
  }
}

// 模板加载（仅调用方提供 templateUrl 时；404 视为无模板）
const templateLoading = ref(false)
const templateError = ref('')

watch(
  () => props.problem,
  async (p) => {
    if (!p || !props.templateUrl) return
    if (code.value.trim() !== '') return
    // 等一拍让 useDraftStorage 完成 localStorage 恢复
    await nextTick()
    await nextTick()
    if (code.value.trim() !== '') return
    if (draftState.value === 'saved' || draftState.value === 'dirty' || draftState.value === 'saving') return

    templateLoading.value = true
    templateError.value = ''
    try {
      const res = await api.get<{ data: { content: string; language: string } }>(
        props.templateUrl(p.id),
        { silent: true },
      )
      if (res?.data?.content && code.value.trim() === '') {
        code.value = res.data.content
      }
    } catch (e: unknown) {
      const err = e as { statusCode?: number }
      if (err.statusCode !== 404) {
        templateError.value = extractApiError(e).message
      }
    } finally {
      templateLoading.value = false
    }
  },
  { immediate: true },
)

function openSettings() {
  sidebarTab.value = 'settings'
  sidebarVisible.value = true
}

function goBack() {
  router.push(props.backUrl)
}

function openSubmission(id: string) {
  router.push(props.openSubmissionUrl(id))
}

function onCursorChange(pos: { line: number; col: number }) {
  cursor.value = pos
}

// 工具栏只消费标题相关字段
const toolbarProblem = computed(() => {
  const p = props.problem!
  return {
    id: p.id,
    display_id: p.display_id,
    title: p.title,
    type: p.type,
  }
})
</script>

<template>
  <div
    class="h-screen flex flex-col overflow-hidden bg-bg-page"
    :class="{ 'editor-dark': theme === 'dark' }"
  >
    <ClientOnly>
      <!-- 加载状态 -->
      <div v-if="pending" class="flex-1 flex items-center justify-center bg-bg-page">
        <div class="flex flex-col items-center gap-3 text-text-muted">
          <div class="size-7 border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
          <span class="text-sm">加载题目...</span>
        </div>
      </div>

      <!-- 错误状态 -->
      <div v-else-if="error || !problem" class="flex-1 flex items-center justify-center bg-bg-page">
        <div class="flex flex-col items-center gap-3 text-text-muted">
          <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
          <p class="text-sm">{{ templateError || '题目加载失败' }}</p>
          <div class="flex gap-2">
            <UButton color="primary" variant="outline" class="text-sm" @click="retry">
              <UIcon name="i-lucide-rotate-cw" class="size-3.5" />重试
            </UButton>
            <UButton color="neutral" variant="outline" class="text-sm" @click="goBack">{{ backLabel }}</UButton>
          </div>
        </div>
      </div>

      <!-- 正常状态 -->
      <template v-else>
        <EditorToolbar
          :problem="toolbarProblem"
          :language="language"
          :languages="languages"
          :theme-mode="theme"
          :can-submit="canSubmit"
          :submitting="submitting"
          :sidebar-visible="sidebarVisible"
          :draft-state="draftState"
          :draft-saved-at="draftSavedAt"
          :badge="problem.label"
          :subtitle="subtitle"
          @update:language="language = $event"
          @update:theme-mode="setTheme($event)"
          @open-settings="openSettings"
          @toggle-sidebar="sidebarVisible = !sidebarVisible"
          @submit="handleSubmit"
          @back="goBack"
        >
          <template #actions>
            <slot name="toolbar-actions" />
          </template>
        </EditorToolbar>

        <div class="flex-1 flex min-h-0">
          <ActivityBar
            :active="sidebarTab"
            @select="(v) => { sidebarTab = v; sidebarVisible = true }"
          />

          <!-- 侧栏（可隐藏 + 可拖拽） -->
          <template v-if="sidebarVisible">
            <div :style="{ width: `${sidebarWidth}px` }" class="flex-shrink-0 transition-[width] duration-200">
              <EditorSidebar
                :active="sidebarTab"
                :problem="problem"
                :submissions="submissions"
                :active-submission="activeSubmission"
                :is-polling-active="isPollingActive"
                :theme-mode="theme"
                :draft-enabled="draftEnabled"
                @update:theme-mode="setTheme($event)"
                @update:draft-enabled="draftEnabled = $event"
                @clear-draft="clearDraft"
                @open-submission="openSubmission"
              />
            </div>
            <ResizableSplitter
              v-model="sidebarWidth"
              :min="240"
              :max="480"
              side="right"
            />
          </template>

          <!-- 主编辑区 -->
          <main class="flex-1 flex flex-col min-w-0 h-full min-h-0">
            <ClientOnly>
              <MonacoEditor
                v-model="code"
                :language="language"
                :theme="theme === 'dark' ? 'vs-dark' : 'vs'"
                :disabled="!isLoggedIn || submitting || !$props.canSubmit"
                :min-height="400"
                @cursor-change="onCursorChange"
              />
              <template #fallback>
                <div class="flex-1 flex items-center justify-center bg-[#0d1117] text-[#8b949e] text-sm">
                  <div class="flex flex-col items-center gap-3">
                    <div class="size-7 border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
                    <span>加载编辑器...</span>
                  </div>
                </div>
              </template>
            </ClientOnly>

            <!-- 提交错误 banner -->
            <Transition
              enter-active-class="transition-all duration-200 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div v-if="submitError" class="border-t border-red-200">
                <UAlert color="error" icon="i-lucide-alert-circle" :title="submitError" :close="true" class="rounded-none">
                  <template #close>
                    <UButton color="neutral" variant="link" icon="i-lucide-x" aria-label="关闭" @click="submitError = ''" />
                  </template>
                </UAlert>
              </div>
            </Transition>

            <EditorStatusBar
              :language="language"
              :cursor="cursor"
              :total-lines="totalLines"
              :total-chars="totalChars"
            />
          </main>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
