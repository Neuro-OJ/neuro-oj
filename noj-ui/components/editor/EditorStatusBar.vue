<script setup lang="ts">
import type { DraftState } from '~/composables/useDraftStorage'

const props = defineProps<{
  language: string
  cursor: { line: number; col: number }
  totalLines: number
  totalChars: number
  draftState: DraftState
  draftSavedAt: Date | null
}>()

// 响应式时钟，让 savedAtLabel 跟随时间推进刷新
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  // SSR 安全：仅在浏览器环境启动定时器
  if (!import.meta.client) return
  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 5000)
})
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
})

const draftLabel = computed(() => {
  switch (props.draftState) {
    case 'dirty':
      return '编辑中…'
    case 'saving':
      return '保存中…'
    case 'error':
      return '保存失败'
    case 'saved':
    case 'idle':
      return savedAtLabel.value
    default:
      return ''
  }
})

const draftDotClass = computed(() => {
  switch (props.draftState) {
    case 'dirty':
      return 'bg-orange-500'
    case 'saving':
      return 'bg-blue-500 animate-pulse'
    case 'error':
      return 'bg-red-500'
    case 'saved':
      return 'bg-green-500'
    default:
      return 'bg-text-muted'
  }
})

const savedAtLabel = computed(() => {
  if (!props.draftSavedAt) return '未保存'
  const diff = Math.floor((now.value - props.draftSavedAt.getTime()) / 1000)
  if (diff < 2) return '刚刚已保存'
  if (diff < 60) return `${diff}s 前已保存`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前已保存`
  return props.draftSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 已保存'
})

const charsLabel = computed(() => {
  return `${props.totalChars.toLocaleString('zh-CN')} 字符`
})
</script>

<template>
  <div class="h-6 flex-shrink-0 bg-bg-dark-2 border-t border-bg-dark-3 flex items-center px-3 gap-4 text-[11px] text-text-muted font-mono ml-auto">
    <span class="flex items-center gap-1.5">
      <span class="size-1.5 rounded-full" :class="draftDotClass" />
      <span>{{ draftLabel }}</span>
    </span>
    <span>{{ language }}</span>
    <span>Ln {{ cursor.line }}, Col {{ cursor.col }}</span>
    <span>{{ totalLines }} 行</span>
    <span>{{ charsLabel }}</span>
  </div>
</template>
