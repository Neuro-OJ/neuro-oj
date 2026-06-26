<script setup lang="ts">
import { getLanguageLabel, formatScore } from "~/composables/use-submissions"
import { Clock, CheckCircle, XCircle, Loader2 } from "@lucide/vue"

interface QueueItem {
  id: string
  problem_id: string
  problem_title: string
  language: string
  submitted_at: string
  submitted_by: string
  judge_started_at?: string | null
  judge_finished_at?: string | null
  status?: string
  score?: number | null
}

interface QueueStats {
  pending_count: number
  judging_count: number
  completed_today: number
}

interface QueueData {
  pending: QueueItem[]
  judging: QueueItem[]
  recently_completed: QueueItem[]
  stats: QueueStats
}

const data = ref<QueueData | null>(null)

const isMounted = ref(true)

// 实时时钟——确保 elapsed 时间每秒更新而不是仅在轮询时刷新
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { clockTimer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => {
  isMounted.value = false
  if (clockTimer) clearInterval(clockTimer); clockTimer = null
})

// 语言标签映射
function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatScore(raw: number | null | undefined): string {
  if (raw === null || raw === undefined) return "--"
  return (raw / 100).toFixed(1)
}

function elapsedSince(iso: string | null | undefined): string {
  if (!iso) return "--"
  const ms = now.value - new Date(iso).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

// 使用轮询每 2s 刷新
usePolling(async () => {
  try {
    data.value = await $fetch<QueueData>("/api/v1/queue")
  } catch {
    // 静默
  }
}, { intervalMs: 2000 })
</script>

<template>
  <div class="max-w-[900px] mx-auto px-4 py-6 pb-16">
    <div class="container">
      <h1 class="text-2xl font-bold mb-4">评测队列</h1>

      <!-- 统计条 -->
      <div class="flex gap-3 mb-6 flex-wrap" v-if="data">
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#f0f0f0] text-text-secondary">
          <Loader2 :size="14" class="animate-spin" />
          排队中 {{ data.stats.pending_count }}
        </div>
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#e8f0fe] text-[#1967d2]">
          <Loader2 :size="14" class="animate-spin" />
          正在评测 {{ data.stats.judging_count }}
        </div>
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#e6f4ea] text-[var(--c-success-text)]">
          <CheckCircle :size="14" />
          今日完成 {{ data.stats.completed_today }}
        </div>
      </div>

      <div v-if="!data" class="flex items-center justify-center gap-2 py-16 text-text-muted">
        <Loader2 :size="24" class="animate-spin" />
        <span>加载中...</span>
      </div>

      <template v-else>
        <!-- 正在评测 -->
        <section class="bg-white border border-border rounded-[10px] mb-4 overflow-hidden">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-[15px] font-bold border-b border-border text-[#1967d2]">
            <Loader2 :size="18" class="animate-spin" />
            正在评测（{{ data.judging.length }}）
          </h2>
          <div v-if="data.judging.length === 0" class="p-4 text-center text-[#aaa] text-[13px]">暂无</div>
          <div v-for="item in data.judging" :key="item.id" class="flex items-center gap-3 px-4 py-2.5 text-[13px] border-b border-[#f3f4f6] last:border-b-0 hover:bg-bg-page">
            <NuxtLink :to="`/submissions/${item.id}`" class="text-[#1967d2] no-underline font-mono whitespace-nowrap min-w-[80px] hover:underline">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="text-text-secondary min-w-[70px] text-center text-xs">{{ getLanguageLabel(item.language) }}</span>
            <span class="text-text-secondary min-w-[60px]">{{ item.submitted_by }}</span>
            <span class="text-text-muted text-xs min-w-[100px]">{{ formatDateTime(item.submitted_at) }}</span>
            <span class="inline-flex items-center gap-[3px] text-[#1967d2] text-xs min-w-[70px]"><Clock :size="14" /> {{ elapsedSince(item.judge_started_at) }}</span>
          </div>
        </section>

        <!-- 排队中 -->
        <section class="bg-white border border-border rounded-[10px] mb-4 overflow-hidden">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-[15px] font-bold border-b border-border text-text-secondary">
            <Clock :size="18" />
            排队中（{{ data.pending.length }}）
          </h2>
          <div v-if="data.pending.length === 0" class="p-4 text-center text-[#aaa] text-[13px]">暂无</div>
          <div v-for="item in data.pending" :key="item.id" class="flex items-center gap-3 px-4 py-2.5 text-[13px] border-b border-[#f3f4f6] last:border-b-0 hover:bg-bg-page">
            <NuxtLink :to="`/submissions/${item.id}`" class="text-[#1967d2] no-underline font-mono whitespace-nowrap min-w-[80px] hover:underline">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="text-text-secondary min-w-[70px] text-center text-xs">{{ getLanguageLabel(item.language) }}</span>
            <span class="text-text-secondary min-w-[60px]">{{ item.submitted_by }}</span>
            <span class="text-text-muted text-xs min-w-[100px]">{{ formatDateTime(item.submitted_at) }}</span>
          </div>
        </section>

        <!-- 最近完成 -->
        <section class="bg-white border border-border rounded-[10px] mb-4 overflow-hidden">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-[15px] font-bold border-b border-border text-[var(--c-success-text)]">
            <CheckCircle :size="18" />
            最近完成（{{ data.recently_completed.length }}）
          </h2>
          <div v-if="data.recently_completed.length === 0" class="p-4 text-center text-[#aaa] text-[13px]">暂无</div>
          <div v-for="item in data.recently_completed" :key="item.id" class="flex items-center gap-3 px-4 py-2.5 text-[13px] border-b border-[#f3f4f6] last:border-b-0 hover:bg-bg-page">
            <NuxtLink :to="`/submissions/${item.id}`" class="text-[#1967d2] no-underline font-mono whitespace-nowrap min-w-[80px] hover:underline">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="text-text-secondary min-w-[70px] text-center text-xs">{{ getLanguageLabel(item.language) }}</span>
            <span class="text-text-secondary min-w-[60px]">{{ item.submitted_by }}</span>
            <span class="text-text-muted text-xs min-w-[100px]">{{ formatDateTime(item.submitted_at) }}</span>
            <span :class="['font-semibold min-w-[60px] text-right', item.status === 'error' || (item.score !== null && item.score === 0) ? 'text-[#d93025]' : '']">
              {{ formatScore(item.score) }} 分
            </span>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
