<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { AlertCircle } from '@lucide/vue'

definePageMeta({
  layout: false,
  ssr: false,
})

const route = useRoute()
const router = useRouter()
const problemId = computed(() => route.params.id as string)
const { isLoggedIn } = useAuth()

// 主题
const { theme, set: setTheme } = useEditorTheme()

// 草稿
const code = ref('')
const draftEnabled = ref(true)
const { state: draftState, savedAt: draftSavedAt, clear: clearDraft } = useDraftStorage(problemId, code, draftEnabled)

// 侧栏
const sidebarTab = ref<'description' | 'history' | 'settings'>('description')
const sidebarVisible = ref(true)
const sidebarWidth = useResizableSplit('editor:sidebar:width', 320, 240, 480)

// 提交后实时状态轮询（留在编辑页，不跳转）
const activeSubmissionId = ref<string | null>(null)
const {
  submission: activeSubmission,
  isPolling: isPollingActive,
  start: startPolling,
  stop: stopPolling,
} = useSubmissionPolling(activeSubmissionId)
const sidebarWidthPx = computed({
  get: () => sidebarWidth.width.value,
  set: (value: number) => {
    sidebarWidth.width.value = value
  },
})

// 编辑器元数据（用于状态栏）
const cursor = ref({ line: 1, col: 1 })
const totalLines = computed(() => code.value.split('\n').length)
const totalChars = computed(() => code.value.length)

// 题目加载
const { data: problemData, pending: problemPending, error: problemError } = useFetch<{
  data: {
    id: string
    display_id: string
    title: string
    description: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    type: 'U' | 'P'
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId.value}`, { server: false })

const problem = computed(() => problemData.value?.data ?? null)

// 提交历史
const { data: submissionsData, refresh: refreshSubmissionsFn } = useFetch<{
  data: Array<{
    id: string
    status: string
    score: number
    language: string
    created_at: string
    result: { status: string; score: number } | null
  }>
}>(() => `/api/v1/submissions?problem_id=${problemId.value}&limit=20`, {
  server: false,
  default: () => ({ data: [] }),
})

const submissions = computed(() => submissionsData.value?.data ?? [])

// 语言（仅 Python 3，多语言切换器等 noj-judge 各语言镜像就绪后启用）
const languages = [{ value: 'python3', label: 'Python 3' }]
const language = ref('python3')

// 提交
const submitting = ref(false)
const submitError = ref('')
const canSubmit = computed(() => isLoggedIn.value && code.value.trim().length > 0)

async function handleSubmit() {
  if (!canSubmit.value) {
    submitError.value = isLoggedIn.value ? '请先编写代码' : '请先登录'
    return
  }
  submitting.value = true
  submitError.value = ''
  try {
    const res = await $fetch<{ data: { id: string } }>('/api/v1/submissions', {
      method: 'POST',
      body: {
        problem_id: problemId.value,
        language: language.value,
        code: code.value,
      },
    })
    // 留在编辑页：自动切到历史 tab + 启动实时轮询
    sidebarTab.value = 'history'
    sidebarVisible.value = true
    startPolling(res.data.id)
    // 轮询约 2s 后（judge 入队 + 评测完成），刷新历史列表把最近一条移入
    setTimeout(() => refreshSubmissionsFn(), 2000)
  } catch (err: unknown) {
    const e = err as { data?: { error?: string }; message?: string }
    submitError.value = e.data?.error || e.message || '提交失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

function openSettings() {
  sidebarTab.value = 'settings'
  sidebarVisible.value = true
}

function openSubmission(id: string) {
  router.push(`/submissions/${id}`)
}

function goBack() {
  router.push(`/problems/${problemId.value}`)
}

// Monaco 光标变化回调（通过 ClientOnly 包装的 MonacoEditor 的 @cursor-change 事件接收）
function onCursorChange(pos: { line: number; col: number }) {
  cursor.value = pos
}
</script>

<template>
  <div
    class="h-screen flex flex-col overflow-hidden"
    :class="{ 'editor-dark': theme === 'dark' }"
  >
   <ClientOnly>
    <!-- 加载状态 -->
    <div v-if="problemPending" class="flex-1 flex items-center justify-center bg-bg-page">
      <div class="flex flex-col items-center gap-3 text-text-muted">
        <div class="size-7 border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
        <span class="text-sm">加载题目...</span>
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="problemError || !problem" class="flex-1 flex items-center justify-center bg-bg-page">
      <div class="flex flex-col items-center gap-3 text-text-muted">
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p class="text-sm">题目加载失败</p>
        <button class="btn btn-outline text-sm" @click="goBack">返回题目列表</button>
      </div>
    </div>

    <!-- 正常状态 -->
    <template v-else>
      <EditorToolbar
        :problem="problem"
        :language="language"
        :languages="languages"
        :theme-mode="theme"
        :can-submit="canSubmit"
        :submitting="submitting"
        :sidebar-visible="sidebarVisible"
        @update:language="language = $event"
        @update:theme-mode="setTheme($event)"
        @open-settings="openSettings"
        @toggle-sidebar="sidebarVisible = !sidebarVisible"
        @submit="handleSubmit"
        @back="goBack"
      />

      <div class="flex-1 flex min-h-0">
        <ActivityBar
          :active="sidebarTab"
          @select="(v) => { sidebarTab = v; sidebarVisible = true }"
        />

        <!-- 侧栏（可隐藏 + 可拖拽） -->
        <template v-if="sidebarVisible">
          <div :style="{ width: `${sidebarWidthPx}px` }" class="flex-shrink-0 transition-[width] duration-200">
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
            v-model="sidebarWidthPx"
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
              :disabled="!isLoggedIn || submitting"
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
            <div
              v-if="submitError"
              class="flex items-center gap-2 px-4 py-2.5 bg-red-50 border-t border-red-200 text-red-800 text-xs"
            >
              <AlertCircle :size="14" />
              <span class="flex-1">{{ submitError }}</span>
              <button class="text-red-600 hover:text-red-800" @click="submitError = ''">×</button>
            </div>
          </Transition>
        </main>

        <EditorStatusBar
          :language="language"
          :cursor="cursor"
          :total-lines="totalLines"
          :total-chars="totalChars"
          :draft-state="draftState"
          :draft-saved-at="draftSavedAt"
        />
      </div>
    </template>
   </ClientOnly>
  </div>
</template>
