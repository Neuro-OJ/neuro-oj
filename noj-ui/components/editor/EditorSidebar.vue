<script setup lang="ts">
import { Clock, Server, Sun, Moon, Trash2, ChevronRight, Loader2, Timer, MemoryStick } from '@lucide/vue'
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue'
import { getStatusColor, getStatusLabel } from '~/composables/use-submissions'
import type { EditorTheme } from '~/composables/useEditorTheme'
import type { PolledSubmission } from '~/composables/useSubmissionPolling'

type Tab = 'description' | 'history' | 'settings'

interface Problem {
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

interface Submission {
  id: string
  status: string
  score: number
  language: string
  created_at: string
  result: { status: string; score: number } | null
}

const props = defineProps<{
  active: Tab
  problem: Problem
  submissions: Submission[]
  activeSubmission: PolledSubmission | null
  isPollingActive: boolean
  themeMode: EditorTheme
  draftEnabled: boolean
}>()

const emit = defineEmits<{
  'update:themeMode': [value: EditorTheme]
  'update:draftEnabled': [value: boolean]
  'clear-draft': []
  'open-submission': [id: string]
}>()

const recentSubmissions = computed(() => {
  // 优先显示当前正在轮询的那一条
  if (props.activeSubmission) {
    return [props.activeSubmission]
  }
  // 否则从历史里取最近的一条（API 已按 created_at DESC 排序）
  if (historySubmissions.value.length > 0) {
    return [historySubmissions.value[0]]
  }
  return []
})

const historySubmissions = computed(() => props.submissions)

// 实时时钟：用于卡片内「已等待 Ns」显示
const liveNow = ref(Date.now())
let liveTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  liveTimer = setInterval(() => { liveNow.value = Date.now() }, 500)
})
onUnmounted(() => {
  if (liveTimer) clearInterval(liveTimer)
})

function formatScore(s: number | undefined) {
  if (s == null) return '—'
  return `${(s / 100).toFixed(0)}`
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const diff = Math.floor((liveNow.value - d.getTime()) / 1000)
  if (diff < 60) return `${diff}s 前`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function formatElapsed(iso: string) {
  const diff = Math.floor((liveNow.value - new Date(iso).getTime()) / 1000)
  if (diff < 0) return '0s'
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`
  return `${Math.floor(diff / 3600)}h`
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-white border-r border-border transition-colors duration-300">
    <!-- 描述 tab -->
    <div v-if="active === 'description'" class="p-4 space-y-4">
        <div class="flex items-center gap-2 flex-wrap text-xs text-text-secondary">
          <span
            class="inline-flex items-center px-2 py-0.5 rounded-full font-semibold"
            :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
          >
            {{ problem.display_id }}
          </span>
          <span class="inline-flex items-center gap-1">
            <Clock :size="12" />
            {{ problem.time_limit_ms }}ms
          </span>
          <span class="inline-flex items-center gap-1">
            <Server :size="12" />
            {{ problem.memory_limit_mb }}MB
          </span>
          <span class="font-medium">{{ problem.difficulty }}</span>
      </div>

      <div v-if="problem.categories.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="cat in problem.categories"
          :key="cat.id"
          class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
        >
          {{ cat.name }}
        </span>
      </div>

      <div class="prose prose-sm prose-neuro max-w-none">
        <MarkdownRenderer :content="problem.description" />
      </div>
    </div>

    <!-- 历史 tab -->
    <div v-else-if="active === 'history'" class="p-4 space-y-4">
      <!-- 最近（实时轮询，最多一张卡片） -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-semibold text-text">最近</h3>
          <Loader2 v-if="isPollingActive" :size="12" class="animate-spin text-primary" />
        </div>
        <div v-if="recentSubmissions.length === 0" class="text-xs text-text-muted text-center py-4 border border-dashed border-border rounded-md">
          点击「提交评测」开始
        </div>
        <button
          v-for="sub in recentSubmissions"
          :key="sub.id"
          class="w-full text-left p-3 rounded-md border-2 border-primary/40 bg-primary-bg/20 hover:border-primary hover:bg-primary-bg/40 transition-colors group relative"
          @click="emit('open-submission', sub.id)"
        >
          <!-- 行 1：状态徽章 + 得分 -->
          <div class="flex items-center justify-between mb-2">
            <span
              class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded font-semibold"
              :style="{ background: getStatusColor(sub.status, sub.result?.status) + '22', color: getStatusColor(sub.status, sub.result?.status) }"
            >
              <Loader2
                v-if="sub.status === 'pending' || sub.status === 'judging'"
                :size="10"
                class="animate-spin"
              />
              {{ getStatusLabel(sub.status, sub.result?.status) }}
            </span>
            <span class="text-sm font-mono font-semibold text-text">
              <template v-if="sub.result && sub.status === 'finished'">
                {{ formatScore(sub.result.score) }} 分
              </template>
              <template v-else>—</template>
            </span>
          </div>

          <!-- 行 2：用时 / 内存（仅 finished 显示） -->
          <div
            v-if="sub.status === 'finished' && (sub.result?.time_ms || sub.result?.memory_kb)"
            class="flex items-center gap-3 text-xs text-text-muted mb-2"
          >
            <span v-if="sub.result?.time_ms" class="inline-flex items-center gap-1">
              <Timer :size="11" />
              {{ sub.result.time_ms }}ms
            </span>
            <span v-if="sub.result?.memory_kb" class="inline-flex items-center gap-1">
              <MemoryStick :size="11" />
              {{ Math.round(sub.result.memory_kb / 1024) }}MB
            </span>
          </div>

          <!-- 行 4：底部 — 语言 + 已等待时长 -->
          <div class="flex items-center justify-between text-xs text-text-muted border-t border-primary/20 pt-2">
            <span class="font-mono">{{ sub.language }}</span>
            <span v-if="sub.status === 'pending' || sub.status === 'judging'">
              已等待 {{ formatElapsed(sub.created_at) }}
            </span>
            <span v-else>{{ formatTime(sub.created_at) }}</span>
          </div>

          <ChevronRight
            :size="14"
            class="absolute right-2 top-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
          />
        </button>
      </div>

      <!-- 历史（已完成） -->
      <div>
        <h3 class="text-sm font-semibold text-text mb-2">历史</h3>
        <div v-if="historySubmissions.length === 0" class="text-xs text-text-muted text-center py-4">
          暂无提交记录
        </div>
        <button
          v-for="sub in historySubmissions"
          :key="sub.id"
          class="w-full text-left p-3 rounded-md border border-border hover:border-primary hover:bg-bg-page transition-colors group relative mb-2"
          @click="emit('open-submission', sub.id)"
        >
          <div class="flex items-center justify-between mb-1">
            <span
              class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium"
              :style="{ background: getStatusColor(sub.status, sub.result?.status) + '18', color: getStatusColor(sub.status, sub.result?.status) }"
            >
              {{ getStatusLabel(sub.status, sub.result?.status) }}
            </span>
            <span class="text-xs font-mono text-text-secondary">{{ formatScore(sub.result?.score ?? 0) }} 分</span>
          </div>
          <div class="flex items-center justify-between text-xs text-text-muted">
            <span class="font-mono">{{ sub.language }}</span>
            <span>{{ formatTime(sub.created_at) }}</span>
          </div>
          <ChevronRight
            :size="14"
            class="absolute right-2 top-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
          />
        </button>
      </div>
    </div>

    <!-- 设置 tab -->
    <div v-else-if="active === 'settings'" class="p-4 space-y-5">
      <h3 class="text-sm font-semibold text-text">设置</h3>

      <div class="space-y-2">
        <label class="text-xs font-medium text-text-secondary">主题</label>
        <div class="flex items-center gap-2">
          <button
            class="flex-1 inline-flex items-center justify-center gap-2 py-2 px-3 border rounded-md text-sm transition-colors"
            :class="themeMode === 'light' ? 'border-primary bg-primary-bg text-primary' : 'border-border hover:bg-bg-page'"
            @click="emit('update:themeMode', 'light')"
          >
            <Sun :size="16" />
            亮色
          </button>
          <button
            class="flex-1 inline-flex items-center justify-center gap-2 py-2 px-3 border rounded-md text-sm transition-colors"
            :class="themeMode === 'dark' ? 'border-primary bg-primary-bg text-primary' : 'border-border hover:bg-bg-page'"
            @click="emit('update:themeMode', 'dark')"
          >
            <Moon :size="16" />
            暗色
          </button>
        </div>
      </div>

      <div class="space-y-2">
        <label class="text-xs font-medium text-text-secondary">自动保存草稿</label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            :checked="draftEnabled"
            class="size-4 accent-primary"
            @change="emit('update:draftEnabled', ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-sm">本地保存代码草稿</span>
        </label>
        <p class="text-xs text-text-muted leading-relaxed">
          关闭后不再保存代码到浏览器，刷新页面会丢失未提交的代码。
        </p>
      </div>

      <div class="pt-2 border-t border-border">
        <button
          class="w-full inline-flex items-center justify-center gap-2 py-2 px-3 border border-red-200 text-red-700 bg-red-50 rounded-md text-sm hover:bg-red-100 transition-colors"
          @click="emit('clear-draft')"
        >
          <Trash2 :size="14" />
          清除当前草稿
        </button>
      </div>
    </div>
  </div>
</template>
