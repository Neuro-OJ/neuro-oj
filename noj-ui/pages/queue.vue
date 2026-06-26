<script setup lang="ts">
import { getLanguageLabel, formatScore } from "\~\/composables\/use\-submissions"
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
isMounted.value = false
  onUnmounted(() => { if (clockTimer) clearInterval(clockTimer); clockTimer = null })

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
  <div class="queue-page">
    <div class="container">
      <h1 class="page-title">评测队列</h1>

      <!-- 统计条 -->
      <div class="stats-bar" v-if="data">
        <div class="stat-chip stat-pending">
          <Loader2 :size="14" class="spin" />
          排队中 {{ data.stats.pending_count }}
        </div>
        <div class="stat-chip stat-judging">
          <Loader2 :size="14" class="spin" />
          正在评测 {{ data.stats.judging_count }}
        </div>
        <div class="stat-chip stat-done">
          <CheckCircle :size="14" />
          今日完成 {{ data.stats.completed_today }}
        </div>
      </div>

      <div v-if="!data" class="loading-wrap">
        <Loader2 :size="24" class="spin" />
        <span>加载中...</span>
      </div>

      <template v-else>
        <!-- 正在评测 -->
        <section class="queue-section">
          <h2 class="section-title judging-title">
            <Loader2 :size="18" class="spin" />
            正在评测（{{ data.judging.length }}）
          </h2>
          <div v-if="data.judging.length === 0" class="empty-row">暂无</div>
          <div v-for="item in data.judging" :key="item.id" class="queue-row">
            <NuxtLink :to="`/submissions/${item.id}`" class="row-id">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="row-problem">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="row-lang">{{ getLanguageLabel(item.language) }}</span>
            <span class="row-user">{{ item.submitted_by }}</span>
            <span class="row-time">{{ formatDateTime(item.submitted_at) }}</span>
            <span class="row-elapsed"><Clock :size="14" /> {{ elapsedSince(item.judge_started_at) }}</span>
          </div>
        </section>

        <!-- 排队中 -->
        <section class="queue-section">
          <h2 class="section-title pending-title">
            <Clock :size="18" />
            排队中（{{ data.pending.length }}）
          </h2>
          <div v-if="data.pending.length === 0" class="empty-row">暂无</div>
          <div v-for="item in data.pending" :key="item.id" class="queue-row">
            <NuxtLink :to="`/submissions/${item.id}`" class="row-id">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="row-problem">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="row-lang">{{ getLanguageLabel(item.language) }}</span>
            <span class="row-user">{{ item.submitted_by }}</span>
            <span class="row-time">{{ formatDateTime(item.submitted_at) }}</span>
          </div>
        </section>

        <!-- 最近完成 -->
        <section class="queue-section">
          <h2 class="section-title done-title">
            <CheckCircle :size="18" />
            最近完成（{{ data.recently_completed.length }}）
          </h2>
          <div v-if="data.recently_completed.length === 0" class="empty-row">暂无</div>
          <div v-for="item in data.recently_completed" :key="item.id" class="queue-row">
            <NuxtLink :to="`/submissions/${item.id}`" class="row-id">#{{ item.id.slice(0, 8) }}</NuxtLink>
            <span class="row-problem">{{ item.problem_id }} {{ item.problem_title }}</span>
            <span class="row-lang">{{ getLanguageLabel(item.language) }}</span>
            <span class="row-user">{{ item.submitted_by }}</span>
            <span class="row-time">{{ formatDateTime(item.submitted_at) }}</span>
            <span :class="['row-score', item.status === 'error' || (item.score !== null && item.score === 0) ? 'score-zero' : '']">
              {{ formatScore(item.score) }} 分
            </span>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.queue-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 16px 60px;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 16px;
}

.stats-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
}

.stat-pending {
  background: #f0f0f0;
  color: var(--c-text-secondary); /* #555 */
}

.stat-judging {
  background: #e8f0fe;
  color: #1967d2;
}

.stat-done {
  background: #e6f4ea;
  color: var(--c-success-text); /* #137333 */
}

.loading-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 60px 0;
  color: var(--c-text-muted); /* #888 */
}

.spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.queue-section {
  background: #fff;
  border: 1px solid var(--c-border); /* #e5e7eb */
  border-radius: 10px;
  margin-bottom: 16px;
  overflow: hidden;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--c-border); /* #e5e7eb */
}

.judging-title {
  color: #1967d2;
}

.pending-title {
  color: var(--c-text-secondary); /* #555 */
}

.done-title {
  color: var(--c-success-text); /* #137333 */
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  font-size: 13px;
  border-bottom: 1px solid #f3f4f6;
}

.queue-row:last-child {
  border-bottom: none;
}

.queue-row:hover {
  background: var(--c-bg-page); /* #f9fafb */
}

.row-id {
  color: #1967d2;
  text-decoration: none;
  font-family: monospace;
  white-space: nowrap;
  min-width: 80px;
}

.row-id:hover {
  text-decoration: underline;
}

.row-problem {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text); /* #111 */
}

.row-lang {
  color: var(--c-text-secondary); /* #555 */
  min-width: 70px;
  text-align: center;
  font-size: 12px;
}

.row-user {
  color: var(--c-text-secondary); /* #555 */
  min-width: 60px;
}

.row-time {
  color: var(--c-text-muted); /* #888 */
  font-size: 12px;
  min-width: 100px;
}

.row-elapsed {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #1967d2;
  font-size: 12px;
  min-width: 70px;
}

.row-score {
  font-weight: 600;
  min-width: 60px;
  text-align: right;
}

.score-zero {
  color: #d93025;
}

.empty-row {
  padding: 16px;
  text-align: center;
  color: #aaa;
  font-size: 13px;
}
</style>
