<script setup lang="ts">
import { Users, BookOpen, Files, Activity, RefreshCw, Loader2, AlertCircle } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

// 认证守卫
watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface StatsCard {
  label: string
  value: number
  icon: Component
  color: string
}

const stats = ref<StatsCard[]>([])
const statsLoading = ref(true)
const statsError = ref("")
const queueStats = ref<{ pending_count: number; judging_count: number; completed_today: number } | null>(null)

async function loadStats() {
  statsLoading.value = true
  statsError.value = ""

  // 分别请求，单个失败不影响其他统计项
  const [userRes, problemRes, submissionRes, queueRes] = await Promise.all([
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/users")
      .catch(() => null),
    $fetch<{ total: number }>("/api/v1/problems")
      .catch(() => null),
    $fetch<{ pagination: { total: number } }>("/api/v1/admin/submissions")
      .catch(() => null),
    $fetch<{ stats: { pending_count: number; judging_count: number; completed_today: number } }>("/api/v1/queue")
      .catch(() => null),
  ])

  const allStats: StatsCard[] = []
  if (userRes) allStats.push({ label: "用户总数", value: userRes.pagination.total, icon: Users, color: "#3b82f6" })
  if (problemRes) allStats.push({ label: "题目总数", value: problemRes.total, icon: BookOpen, color: "#10b981" })
  if (submissionRes) allStats.push({ label: "提交总数", value: submissionRes.pagination.total, icon: Files, color: "#f59e0b" })
  stats.value = allStats
  queueStats.value = queueRes?.stats ?? null

  if (allStats.length === 0 && !queueRes) {
    statsError.value = "加载统计数据失败"
  }

  statsLoading.value = false
}

// 等 auth 就绪后加载
watch(isLoggedIn, (val) => {
  if (val) loadStats()
}, { immediate: true })

const refreshing = ref(false)
async function handleRefresh() {
  refreshing.value = true
  await loadStats()
  refreshing.value = false
}
</script>

<template>
  <div class="dashboard">
    <!-- 顶栏 -->
    <div class="header">
      <h1 class="title">仪表盘</h1>
      <button class="btn btn-outline" :disabled="refreshing" @click="handleRefresh">
        <RefreshCw :size="16" :class="{ spin: refreshing }" />
        {{ refreshing ? "刷新中..." : "刷新" }}
      </button>
    </div>

    <!-- 加载态 -->
    <div v-if="statsLoading && stats.length === 0" class="state-box">
      <Loader2 :size="24" class="spin" />
      <span>加载中...</span>
    </div>

    <!-- 错误态 -->
    <div v-else-if="statsError && stats.length === 0" class="state-box error">
      <AlertCircle :size="20" />
      <span>{{ statsError }}</span>
      <button class="btn btn-outline mt-4" @click="loadStats">重试</button>
    </div>

    <!-- 统计卡片 -->
    <div v-else class="stats-grid">
      <div
        v-for="card in stats"
        :key="card.label"
        class="stat-card"
      >
        <div class="stat-icon" :style="{ background: card.color + '15', color: card.color }">
          <component :is="card.icon" :size="24" />
        </div>
        <div class="stat-info">
          <span class="stat-value">{{ card.value }}</span>
          <span class="stat-label">{{ card.label }}</span>
        </div>
      </div>
    </div>

    <!-- 队列状态 -->
    <div v-if="queueStats" class="queue-section">
      <h2 class="section-title">
        <Activity :size="18" />
        评测队列状态
      </h2>
      <div class="queue-grid">
        <div class="queue-item">
          <span class="queue-value warning">{{ queueStats.pending_count }}</span>
          <span class="queue-label">等待中</span>
        </div>
        <div class="queue-item">
          <span class="queue-value info">{{ queueStats.judging_count }}</span>
          <span class="queue-label">评测中</span>
        </div>
        <div class="queue-item">
          <span class="queue-value success">{{ queueStats.completed_today }}</span>
          <span class="queue-label">今日完成</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
}

.btn-outline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-secondary);
  border: 1.5px solid var(--c-border);
  background: var(--c-white);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-outline:hover:not(:disabled) {
  border-color: var(--c-text-secondary);
}

.btn-outline:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 24px;
  color: var(--c-text-secondary);
  font-size: 14px;
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.state-box.error {
  color: #dc2626;
}

.mt-4 {
  margin-top: 16px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 10px;
  flex-shrink: 0;
}

.stat-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--c-text);
  line-height: 1.2;
}

.stat-label {
  font-size: 13px;
  color: var(--c-text-secondary);
}

.queue-section {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 20px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--c-text);
  margin-bottom: 16px;
}

.queue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.queue-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px;
  border-radius: 8px;
  background: #fafafa;
}

.queue-value {
  font-size: 28px;
  font-weight: 700;
}

.queue-label {
  font-size: 13px;
  color: var(--c-text-secondary);
}

.warning { color: #f59e0b; }
.info { color: #3b82f6; }
.success { color: #10b981; }
</style>
