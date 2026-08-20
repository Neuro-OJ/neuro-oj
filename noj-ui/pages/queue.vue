<script setup lang="ts">
import { useEventSource } from "~/composables/useEventSource"
interface QueueItem {
  id: string
  problem_id: string
  problem_title: string
  language: string
  submitted_at: string
  submitted_by: string
  kind?: 'submission' | 'self_test'
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

const { api } = useApi()

// 实时时钟——确保 elapsed 时间每秒更新而不是仅在轮询时刷新
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { clockTimer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer); clockTimer = null
})

// 语言标签映射

// SSE 实时推送 + 轮询 fallback：优先通过 EventSource 接收队列变更通知
// SSE 不可用时自动降级到 2s 轮询
useEventSource({
  url: "/api/v1/queue/events",
  onEvent: {
    "queue:changed": async () => {
      try {
        data.value = await api.get<QueueData>("/api/v1/queue", { silent: true })
      } catch {
        // 静默
      }
    },
  },
  fetchFn: async () => {
    try {
      data.value = await api.get<QueueData>("/api/v1/queue", { silent: true })
    } catch {
      // 静默
    }
  },
  fallbackIntervalMs: 2000,
})
</script>

<template>
  <div class="max-w-[900px] mx-auto px-4 py-6 pb-16">
    <div class="container">
      <h1 class="text-2xl font-bold mb-4">评测队列</h1>

      <!-- 统计条 -->
      <div class="flex gap-3 mb-6 flex-wrap" v-if="data">
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-gray-100 text-text-secondary">
          <UIcon name="i-lucide-clock" class="size-3.5" />
          排队中 {{ data.stats.pending_count }}
        </div>
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
          <UIcon name="i-lucide-play" class="size-3.5" />
          正在评测 {{ data.stats.judging_count }}
        </div>
        <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-green-50 text-green-700">
          <UIcon name="i-lucide-check-circle" class="size-3.5" />
          今日完成 {{ data.stats.completed_today }}
        </div>
      </div>

      <div v-if="!data" class="flex items-center justify-center gap-2 py-16 text-text-muted">
        <UIcon name="i-lucide-loader-2" class="size-6" />
        <span>加载中...</span>
      </div>

      <template v-else>
        <!-- 正在评测 -->
        <section class="bg-white border border-border rounded-xl mb-4 overflow-x-auto">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-15px font-bold border-b border-border text-blue-700">
            <UIcon name="i-lucide-play" class="size-4.5" />
            正在评测（{{ data.judging.length }}）
          </h2>
          <div v-if="data.judging.length === 0" class="p-4 text-center text-text-muted text-13px">暂无</div>
          <QueueRow v-for="item in data.judging" :key="item.id" :item="item" :now="now" show-elapsed />
        </section>

        <!-- 排队中 -->
        <section class="bg-white border border-border rounded-xl mb-4 overflow-x-auto">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-15px font-bold border-b border-border text-text-secondary">
            <UIcon name="i-lucide-clock" class="size-4.5" />
            排队中（{{ data.pending.length }}）
          </h2>
          <div v-if="data.pending.length === 0" class="p-4 text-center text-text-muted text-13px">暂无</div>
          <QueueRow v-for="item in data.pending" :key="item.id" :item="item" :now="now" />
        </section>

        <!-- 最近完成 -->
        <section class="bg-white border border-border rounded-xl mb-4 overflow-x-auto">
          <h2 class="flex items-center gap-2 px-4 py-3 m-0 text-15px font-bold border-b border-border text-green-700">
            <UIcon name="i-lucide-check-circle" class="size-4.5" />
            最近完成（{{ data.recently_completed.length }}）
          </h2>
          <div v-if="data.recently_completed.length === 0" class="p-4 text-center text-text-muted text-13px">暂无</div>
          <QueueRow v-for="item in data.recently_completed" :key="item.id" :item="item" :now="now" show-score />
        </section>
      </template>
    </div>
  </div>
</template>
